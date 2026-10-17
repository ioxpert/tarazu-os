package com.ioxpert.tarazu.taxrules;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.ioxpert.tarazu.AdminSql;
import com.ioxpert.tarazu.ApiIT;
import com.ioxpert.tarazu.Seed;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.core.env.Environment;
import org.springframework.dao.DataAccessException;
import org.springframework.jdbc.core.JdbcTemplate;

class TaxRulesIT extends ApiIT {

	@Autowired Environment env;

	private String uniquePrefix() {
		return "8" + String.format("%03d", (int) (Math.random() * 1000));
	}

	@Test
	void theRuleInForceDependsOnTheDateAndTheMostSpecificPrefixWins() throws Exception {
		JdbcTemplate admin = AdminSql.of(env);
		String p = uniquePrefix();
		admin.update("INSERT INTO tax_rule (hsn_prefix, description, rate_bp, effective_from, notification_ref) VALUES (?, 'Chapter', 500, '2026-01-01', 'N1') ON CONFLICT DO NOTHING", p);
		admin.update("INSERT INTO tax_rule (hsn_prefix, description, rate_bp, effective_from, notification_ref) VALUES (?, 'Chapter revised', 1800, '2026-10-01', 'N2') ON CONFLICT DO NOTHING", p);
		admin.update("INSERT INTO tax_rule (hsn_prefix, description, rate_bp, effective_from) VALUES (?, 'Heading override', 0, '2026-01-01') ON CONFLICT DO NOTHING", p + "55");
		Seed seed = seedTenant();

		mvc.perform(get("/v1/tax/rules/resolve").header("X-Tenant-Id", seed.tenant()).param("hsn", p + "1234").param("asOf", "2026-09-30"))
				.andExpect(status().isOk()).andExpect(jsonPath("$.rateBp").value(500)).andExpect(jsonPath("$.notificationRef").value("N1"));
		mvc.perform(get("/v1/tax/rules/resolve").header("X-Tenant-Id", seed.tenant()).param("hsn", p + "1234").param("asOf", "2026-10-01"))
				.andExpect(jsonPath("$.rateBp").value(1800));
		mvc.perform(get("/v1/tax/rules/resolve").header("X-Tenant-Id", seed.tenant()).param("hsn", p + "5599").param("asOf", "2026-10-17"))
				.andExpect(jsonPath("$.rateBp").value(0));
		mvc.perform(get("/v1/tax/rules/resolve").header("X-Tenant-Id", seed.tenant()).param("hsn", p + "1234").param("asOf", "2025-12-31"))
				.andExpect(status().isNotFound()).andExpect(jsonPath("$.code").value("no_tax_rule"));
		mvc.perform(get("/v1/tax/rules/resolve").header("X-Tenant-Id", seed.tenant()).param("hsn", "abc").param("asOf", "2026-10-17"))
				.andExpect(status().isNotFound());
	}

	@Test
	void devicesPollAChangeFeedByRowId() throws Exception {
		JdbcTemplate admin = AdminSql.of(env);
		String p = uniquePrefix();
		long before = admin.queryForObject("SELECT coalesce(max(id), 0) FROM tax_rule", Long.class);
		admin.update("INSERT INTO tax_rule (hsn_prefix, description, rate_bp, effective_from) VALUES (?, 'A', 500, '2026-01-01') ON CONFLICT DO NOTHING", p);
		admin.update("INSERT INTO tax_rule (hsn_prefix, description, rate_bp, effective_from) VALUES (?, 'B', 1200, '2026-06-01') ON CONFLICT DO NOTHING", p);
		Seed seed = seedTenant();
		mvc.perform(get("/v1/tax/rules").header("X-Tenant-Id", seed.tenant()).param("sinceId", String.valueOf(before)).param("limit", "1"))
				.andExpect(status().isOk()).andExpect(jsonPath("$.rules.length()").value(1)).andExpect(jsonPath("$.more").value(true));
		var res = mvc.perform(get("/v1/tax/rules").header("X-Tenant-Id", seed.tenant()).param("sinceId", String.valueOf(before)))
				.andExpect(jsonPath("$.more").value(false)).andReturn();
		var maxId = json.readTree(res.getResponse().getContentAsString()).get("maxId").asLong();
		mvc.perform(get("/v1/tax/rules").header("X-Tenant-Id", seed.tenant()).param("sinceId", String.valueOf(maxId)))
				.andExpect(jsonPath("$.rules.length()").value(0)).andExpect(jsonPath("$.maxId").value(maxId));
	}

	@Test
	void thresholdsAreEffectiveDated() throws Exception {
		JdbcTemplate admin = AdminSql.of(env);
		String key = "test_threshold_" + uniquePrefix();
		admin.update("INSERT INTO tax_threshold (key, value_paise, effective_from) VALUES (?, 4000000000, '2026-01-01')", key);
		admin.update("INSERT INTO tax_threshold (key, value_paise, effective_from) VALUES (?, 5000000000, '2026-10-01')", key);
		Seed seed = seedTenant();
		mvc.perform(get("/v1/tax/thresholds").header("X-Tenant-Id", seed.tenant()).param("asOf", "2026-09-01"))
				.andExpect(jsonPath("$[?(@.key=='" + key + "')].valuePaise").value(4000000000L));
		mvc.perform(get("/v1/tax/thresholds").header("X-Tenant-Id", seed.tenant()).param("asOf", "2026-10-17"))
				.andExpect(jsonPath("$[?(@.key=='" + key + "')].valuePaise").value(5000000000L));
	}

	@Test
	void theApiRoleCanReadButNeverWriteRuleTables() throws Exception {
		Seed seed = seedTenant();
		assertThatThrownBy(() -> inTenant(seed.tenant(), () -> jdbc.update(
				"INSERT INTO tax_rule (hsn_prefix, description, rate_bp, effective_from) VALUES ('99', 'forged', 0, '2026-01-01')")))
				.isInstanceOf(DataAccessException.class);
		assertThatThrownBy(() -> inTenant(seed.tenant(), () -> jdbc.update("UPDATE tax_rule SET rate_bp = 0"))).isInstanceOf(DataAccessException.class);
		assertThatThrownBy(() -> inTenant(seed.tenant(), () -> jdbc.update("DELETE FROM tax_rule"))).isInstanceOf(DataAccessException.class);
		assertThatThrownBy(() -> inTenant(seed.tenant(), () -> jdbc.update("UPDATE tax_threshold SET value_paise = 0"))).isInstanceOf(DataAccessException.class);
		assertThat(inTenant(seed.tenant(), () -> jdbc.queryForObject("SELECT count(*) >= 0 FROM tax_rule", Boolean.class))).isTrue();
		// published rows are immutable even for the admin: a correction is a new row with a later effective date
		JdbcTemplate admin = AdminSql.of(env);
		String p = uniquePrefix();
		admin.update("INSERT INTO tax_rule (hsn_prefix, description, rate_bp, effective_from) VALUES (?, 'x', 500, '2026-01-01') ON CONFLICT DO NOTHING", p);
		assertThatThrownBy(() -> admin.update("UPDATE tax_rule SET rate_bp = 1 WHERE hsn_prefix = ?", p)).isInstanceOf(DataAccessException.class);
	}

	@Test
	void ruleEndpointsRequireAuthentication() throws Exception {
		mvc.perform(get("/v1/tax/rules")).andExpect(status().isUnauthorized());
	}
}
