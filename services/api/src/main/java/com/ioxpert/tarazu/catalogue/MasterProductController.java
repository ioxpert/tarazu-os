package com.ioxpert.tarazu.catalogue;

import java.util.regex.Pattern;

import com.ioxpert.tarazu.tenancy.ApiException;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/**
 * Read-only lookup in the platform product master: global reference data, identical for every merchant, loaded by
 * ops (docs/adr/0009). Lets the add-item form pre-fill from a barcode the device has never seen.
 */
@RestController
@RequestMapping("/v1/catalogue")
class MasterProductController {

	private static final Pattern BARCODE = Pattern.compile("[0-9]{6,14}");

	record MasterProduct(String barcode, String name, String localName, String brand, String category, String hsn,
			Long mrpPaise, String unit, JsonNode uom) {
	}

	private final JdbcClient jdbc;
	private final JsonMapper json;

	MasterProductController(JdbcClient jdbc, JsonMapper json) {
		this.jdbc = jdbc;
		this.json = json;
	}

	@GetMapping("/master/{barcode}")
	@Transactional(readOnly = true)
	MasterProduct byBarcode(@PathVariable String barcode) {
		if (!BARCODE.matcher(barcode).matches()) {
			throw ApiException.notFound("no_master_product", "No master product for barcode " + barcode);
		}
		return jdbc.sql("""
				SELECT barcode, name, local_name, brand, category, hsn, mrp_paise, unit, uom::text AS uom
				FROM master_product WHERE barcode = :barcode
				""").param("barcode", barcode)
				.query((rs, n) -> new MasterProduct(rs.getString("barcode"), rs.getString("name"), rs.getString("local_name"),
						rs.getString("brand"), rs.getString("category"), rs.getString("hsn"),
						(Long) rs.getObject("mrp_paise"), rs.getString("unit"),
						rs.getString("uom") == null ? null : json.readTree(rs.getString("uom"))))
				.optional()
				.orElseThrow(() -> ApiException.notFound("no_master_product", "No master product for barcode " + barcode));
	}
}
