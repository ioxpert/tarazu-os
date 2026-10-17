package com.ioxpert.tarazu.taxrules;

import java.time.LocalDate;
import java.util.Optional;

import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Component;

/**
 * Server-controlled, effective-dated GST rules (HSN to rate). A rate change is a new row in tax_rule, not an
 * app release. For an HSN code and a date the rule is the most specific matching prefix whose effective_from
 * is the latest not after the date.
 */
@Component
public class TaxRules {

	public record Rule(long id, String hsnPrefix, String description, int rateBp, int cessBp, LocalDate effectiveFrom,
			String notificationRef) {
	}

	private final JdbcClient jdbc;

	TaxRules(JdbcClient jdbc) {
		this.jdbc = jdbc;
	}

	public Optional<Rule> resolve(String hsn, LocalDate asOf) {
		if (hsn == null || !hsn.matches("[0-9]{2,8}")) {
			return Optional.empty();
		}
		return jdbc.sql("""
				SELECT id, hsn_prefix, description, rate_bp, cess_bp, effective_from, notification_ref FROM tax_rule
				WHERE :hsn LIKE hsn_prefix || '%' AND effective_from <= :asOf
				ORDER BY length(hsn_prefix) DESC, effective_from DESC LIMIT 1
				""").param("hsn", hsn).param("asOf", asOf)
				.query((rs, n) -> new Rule(rs.getLong("id"), rs.getString("hsn_prefix"), rs.getString("description"),
						rs.getInt("rate_bp"), rs.getInt("cess_bp"), rs.getObject("effective_from", LocalDate.class),
						rs.getString("notification_ref")))
				.optional();
	}
}
