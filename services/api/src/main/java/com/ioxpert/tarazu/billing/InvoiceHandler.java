package com.ioxpert.tarazu.billing;

import java.time.LocalDate;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

import com.ioxpert.tarazu.identity.BusinessDirectory;
import com.ioxpert.tarazu.identity.BusinessDirectory.GstMode;
import com.ioxpert.tarazu.identity.Permission;
import com.ioxpert.tarazu.syncgateway.EntityOperationHandler;
import com.ioxpert.tarazu.syncgateway.HandlerResult;
import com.ioxpert.tarazu.syncgateway.InvalidPayloadException;
import com.ioxpert.tarazu.syncgateway.Operation;
import com.ioxpert.tarazu.syncgateway.OperationContext;
import com.ioxpert.tarazu.syncgateway.Payload;
import com.ioxpert.tarazu.taxrules.TaxRules;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Component;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/**
 * A sales invoice is immutable once finalised. The device only syncs finalised invoices (drafts stay local), so a
 * sale that already happened is never rejected for policy: a missing owner approval, a wrong tax rate, a total
 * that does not add up or a document type that does not fit the GST mode are applied AND flagged for review.
 * Corrections are credit notes. A repeated (series, number) with a different invoice id is the one hard rejection:
 * numbers are never reused.
 */
@Component
class InvoiceHandler implements EntityOperationHandler {

	private static final ZoneId IST = ZoneId.of("Asia/Kolkata");
	private static final Set<String> DOC_TYPES = Set.of("tax_invoice", "bill_of_supply", "retail_invoice");

	private final JdbcClient jdbc;
	private final JsonMapper json;
	private final BusinessDirectory businesses;
	private final TaxRules taxRules;

	private final long maxUnapprovedDiscountBp;

	InvoiceHandler(JdbcClient jdbc, JsonMapper json, BusinessDirectory businesses, TaxRules taxRules,
			@org.springframework.beans.factory.annotation.Value("${tarazu.billing.max-unapproved-discount-bp:500}") long maxUnapprovedDiscountBp) {
		this.maxUnapprovedDiscountBp = maxUnapprovedDiscountBp;
		this.jdbc = jdbc;
		this.json = json;
		this.businesses = businesses;
		this.taxRules = taxRules;
	}

	@Override
	public String entityType() {
		return "invoice";
	}

	@Override
	public Set<Permission> permissions(Operation op) {
		return Set.of(Permission.RECORD_SALE);
	}

	record Line(int lineNo, UUID productId, long qtyMilli, long unitPricePaise, long discountPaise, String hsn,
			int taxRateBp, long taxPaise, long lineTotalPaise) {
	}

	@Override
	public HandlerResult handle(Operation op, OperationContext ctx) {
		if (!op.isCreate()) {
			return HandlerResult.rejected("immutable_document",
					"A finalised invoice cannot be changed or voided; issue a credit note (entity credit_note)");
		}
		var p = op.payload();
		String series = p.text("series");
		long number = p.integer("number");
		String docType = p.text("docType");
		if (!DOC_TYPES.contains(docType)) {
			throw new InvalidPayloadException("Field 'docType' must be one of " + DOC_TYPES);
		}
		if (number <= 0) {
			throw new InvalidPayloadException("Field 'number' must be positive");
		}
		LocalDate invoiceDate = p.date("invoiceDate");
		long subtotal = p.integer("subtotalPaise");
		long discount = p.integer("discountPaise", 0);
		long tax = p.integer("taxPaise", 0);
		long roundOff = p.integer("roundOffPaise", 0);
		long total = p.integer("totalPaise");
		if (discount < 0 || tax < 0 || total < 0) {
			throw new InvalidPayloadException("Amounts must not be negative");
		}
		List<Line> lines = lines(p);
		UUID party = p.optUuid("partyId").orElse(null);

		ctx.requireAll("product", new LinkedHashSet<>(lines.stream().map(Line::productId).toList()));
		if (party != null) {
			ctx.require("party", party);
		}

		UUID existing = jdbc.sql("SELECT id FROM invoice WHERE series = :s AND number = :n").param("s", series)
				.param("n", number).query(UUID.class).optional().orElse(null);
		if (existing != null) {
			return existing.equals(op.entityId()) ? HandlerResult.applied() : HandlerResult.rejected(
					"duplicate_invoice_number", "Invoice number %s/%d already belongs to another invoice".formatted(series, number));
		}

		jdbc.sql("""
				INSERT INTO invoice (id, tenant_id, store_id, device_id, series, number, doc_type, invoice_date, party_id,
				                     subtotal_paise, discount_paise, tax_paise, round_off_paise, total_paise, approval, hlc, operation_id)
				VALUES (:id, :tenant, :store, :device, :series, :number, :docType, :date, :party, :subtotal, :discount, :tax,
				        :roundOff, :total, CAST(:approval AS jsonb), :hlc, :op)
				""").param("id", op.entityId()).param("tenant", op.tenantId()).param("store", op.storeId())
				.param("device", op.deviceId()).param("series", series).param("number", number).param("docType", docType)
				.param("date", invoiceDate).param("party", party).param("subtotal", subtotal).param("discount", discount)
				.param("tax", tax).param("roundOff", roundOff).param("total", total)
				.param("approval", Approvals.json(p, json)).param("hlc", op.hlc().raw()).param("op", op.operationId())
				.update();
		for (Line l : lines) {
			jdbc.sql("""
					INSERT INTO invoice_line (tenant_id, invoice_id, line_no, product_id, qty_milli, unit_price_paise,
					                          discount_paise, hsn, tax_rate_bp, tax_paise, line_total_paise)
					VALUES (:tenant, :invoice, :no, :product, :qty, :unit, :discount, :hsn, :rate, :tax, :total)
					""").param("tenant", op.tenantId()).param("invoice", op.entityId()).param("no", l.lineNo())
					.param("product", l.productId()).param("qty", l.qtyMilli()).param("unit", l.unitPricePaise())
					.param("discount", l.discountPaise()).param("hsn", l.hsn()).param("rate", l.taxRateBp())
					.param("tax", l.taxPaise()).param("total", l.lineTotalPaise()).update();
		}

		review(op, ctx, docType, invoiceDate, subtotal, discount, tax, roundOff, total, lines);
		return HandlerResult.applied();
	}

	private void review(Operation op, OperationContext ctx, String docType, LocalDate invoiceDate, long subtotal,
			long discount, long tax, long roundOff, long total, List<Line> lines) {
		String id = op.entityId().toString();

		long lineSum = lines.stream().mapToLong(Line::lineTotalPaise).sum();
		long lineTax = lines.stream().mapToLong(Line::taxPaise).sum();
		if (lineSum != subtotal + tax || lineTax != tax || subtotal + tax - discount + roundOff != total) {
			ctx.flag("total_mismatch", id, "invoice", op.entityId(), Map.of("lineSumPaise", lineSum,
					"lineTaxPaise", lineTax, "subtotalPaise", subtotal, "taxPaise", tax, "discountPaise", discount,
					"roundOffPaise", roundOff, "totalPaise", total));
		}

		// A discount within the unapproved band (default 5% of gross, the same default the counter enforces locally)
		// is a cashier's call; only a larger one needs the owner PIN. See ADR 0006.
		long gross = lines.stream().mapToLong(l -> (l.qtyMilli() * l.unitPricePaise() + 500) / 1000).sum();
		long lineDiscounts = lines.stream().mapToLong(Line::discountPaise).sum() + discount;
		boolean discounted = lineDiscounts > 0 && lineDiscounts * 10_000 > gross * maxUnapprovedDiscountBp;
		boolean backdated = invoiceDate.isBefore(op.hlc().instant().atZone(IST).toLocalDate());
		if (discounted || backdated) {
			boolean approved = Approvals.valid(ctx, op.payload());
			if (approved) {
				ctx.audit("invoice.owner_approved", "invoice", op.entityId(), Approvals.reason(op.payload()),
						Map.of("discount", discounted, "backdated", backdated));
			}
			else {
				ctx.flag("approval_required", id, "invoice", op.entityId(),
						Map.of("discount", discounted, "backdated", backdated));
			}
		}

		GstMode mode = businesses.gstModeOfStore(op.storeId()).orElse(GstMode.NON_GST);
		if (mode == GstMode.COMPOSITION && !"bill_of_supply".equals(docType)) {
			ctx.flag("composition_requires_bill_of_supply", id, "invoice", op.entityId(), Map.of("docType", docType));
		}
		if (mode == GstMode.COMPOSITION && tax > 0) {
			ctx.flag("composition_tax_charged", id, "invoice", op.entityId(), Map.of("taxPaise", tax));
		}
		if (mode == GstMode.NON_GST && "tax_invoice".equals(docType)) {
			ctx.flag("tax_invoice_without_gst_registration", id, "invoice", op.entityId(), Map.of());
		}

		if (mode == GstMode.REGULAR && "tax_invoice".equals(docType)) {
			List<Map<String, Object>> wrong = new ArrayList<>();
			for (Line l : lines) {
				taxRules.resolve(l.hsn(), invoiceDate).filter(r -> r.rateBp() != l.taxRateBp()).ifPresent(r -> {
					if (wrong.size() < 20) {
						Map<String, Object> m = new LinkedHashMap<>();
						m.put("lineNo", l.lineNo());
						m.put("hsn", l.hsn());
						m.put("chargedRateBp", l.taxRateBp());
						m.put("ruleRateBp", r.rateBp());
						m.put("ruleId", r.id());
						wrong.add(m);
					}
				});
			}
			if (!wrong.isEmpty()) {
				ctx.flag("tax_rate_mismatch", id, "invoice", op.entityId(), Map.of("lines", wrong));
			}
		}
	}

	private static List<Line> lines(Payload p) {
		JsonNode array = p.array("lines");
		if (array.isEmpty() || array.size() > 500) {
			throw new InvalidPayloadException("Field 'lines' must have 1 to 500 lines");
		}
		List<Line> lines = new ArrayList<>();
		int no = 1;
		for (JsonNode n : array) {
			Payload l = new Payload(n);
			long qty = l.integer("qtyMilli");
			long unit = l.integer("unitPricePaise");
			long disc = l.integer("discountPaise", 0);
			long tax = l.integer("taxPaise", 0);
			long rate = l.integer("taxRateBp", 0);
			if (qty <= 0 || unit < 0 || disc < 0 || tax < 0 || rate < 0 || rate > 10000) {
				throw new InvalidPayloadException("Line " + no + " has an invalid quantity, price, discount or tax");
			}
			lines.add(new Line(no++, l.uuid("productId"), qty, unit, disc, l.optText("hsn").orElse(null), (int) rate, tax,
					l.integer("lineTotalPaise")));
		}
		return lines;
	}
}
