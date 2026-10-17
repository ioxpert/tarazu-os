package com.ioxpert.tarazu.taxrules;

import java.time.LocalDate;
import java.util.List;

import com.ioxpert.tarazu.tenancy.ApiException;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/** Read-only. Rules are loaded by ops (migration or admin role); the API role cannot write them. */
@RestController
@RequestMapping("/v1/tax")
class TaxRulesController {

	record RulePage(List<TaxRules.Rule> rules, long maxId, boolean more) {
	}

	record Threshold(String key, long valuePaise, LocalDate effectiveFrom, String notificationRef) {
	}

	private final TaxRules rules;
	private final JdbcClient jdbc;

	TaxRulesController(TaxRules rules, JdbcClient jdbc) {
		this.rules = rules;
		this.jdbc = jdbc;
	}

	/** Change feed for devices: every rule row with id > sinceId, oldest first. Poll with the returned maxId. */
	@GetMapping("/rules")
	@Transactional(readOnly = true)
	RulePage page(@RequestParam(defaultValue = "0") long sinceId, @RequestParam(defaultValue = "500") int limit) {
		int capped = Math.max(1, Math.min(limit, 1000));
		List<TaxRules.Rule> page = jdbc.sql("""
				SELECT id, hsn_prefix, description, rate_bp, cess_bp, effective_from, notification_ref FROM tax_rule
				WHERE id > :since ORDER BY id LIMIT :limit
				""").param("since", sinceId).param("limit", capped + 1)
				.query((rs, n) -> new TaxRules.Rule(rs.getLong("id"), rs.getString("hsn_prefix"),
						rs.getString("description"), rs.getInt("rate_bp"), rs.getInt("cess_bp"),
						rs.getObject("effective_from", LocalDate.class), rs.getString("notification_ref")))
				.list();
		boolean more = page.size() > capped;
		List<TaxRules.Rule> items = more ? page.subList(0, capped) : page;
		long maxId = items.isEmpty() ? sinceId : items.get(items.size() - 1).id();
		return new RulePage(items, maxId, more);
	}

	@GetMapping("/rules/resolve")
	@Transactional(readOnly = true)
	TaxRules.Rule resolve(@RequestParam String hsn, @RequestParam LocalDate asOf) {
		return rules.resolve(hsn, asOf)
				.orElseThrow(() -> ApiException.notFound("no_tax_rule", "No tax rule for HSN " + hsn + " on " + asOf));
	}

	@GetMapping("/thresholds")
	@Transactional(readOnly = true)
	List<Threshold> thresholds(@RequestParam LocalDate asOf) {
		return jdbc.sql("""
				SELECT DISTINCT ON (key) key, value_paise, effective_from, notification_ref FROM tax_threshold
				WHERE effective_from <= :asOf ORDER BY key, effective_from DESC
				""").param("asOf", asOf)
				.query((rs, n) -> new Threshold(rs.getString("key"), rs.getLong("value_paise"),
						rs.getObject("effective_from", LocalDate.class), rs.getString("notification_ref")))
				.list();
	}
}
