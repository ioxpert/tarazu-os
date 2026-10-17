package com.ioxpert.tarazu.shift;

import static com.ioxpert.tarazu.Ops.m;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.util.List;
import java.util.Map;
import java.util.UUID;

import com.ioxpert.tarazu.ApiIT;
import com.ioxpert.tarazu.Ops;
import com.ioxpert.tarazu.Seed;
import org.junit.jupiter.api.Test;
import org.springframework.dao.DataAccessException;
import tools.jackson.databind.JsonNode;

/** Cash shifts: the server recomputes expected cash and records variance; money differences never reject a close. */
class ShiftIT extends ApiIT {

	private static Map<String, Object> cash(Ops d, String direction, long amount, String at) {
		return d.create("payment", UUID.randomUUID(), m("direction", direction, "mode", "cash", "amountPaise", amount, "occurredAt", at));
	}

	private List<String> openFlags(Seed seed) {
		return inTenant(seed.tenant(), () -> jdbc.queryForList("SELECT kind FROM conflict_flag WHERE status = 'open' ORDER BY kind", String.class));
	}

	private Map<String, Object> closeRow(Seed seed, UUID shift) {
		return inTenant(seed.tenant(), () -> jdbc.queryForMap("SELECT * FROM shift_close WHERE shift_id = ?", shift));
	}

	@Test
	void aBalancedCloseIsAppliedWithZeroVarianceAndNoFlag() throws Exception {
		Seed seed = seedTenant();
		var d = new Ops(seed);
		UUID shift = UUID.randomUUID();
		var res = upload(seed,
				d.create("shift", shift, m("openingCashPaise", 50_000, "openedAt", "2026-10-17T09:00:00Z")),
				cash(d, "in", 12_000, "2026-10-17T10:00:00Z"),
				cash(d, "out", 2_000, "2026-10-17T11:00:00Z"),
				d.create("shift_close", UUID.randomUUID(), m("shiftId", shift, "declaredCashPaise", 60_000,
						"expectedCashPaise", 60_000, "closedAt", "2026-10-17T18:00:00Z")));
		for (int i = 0; i < 4; i++) {
			assertThat(statusOf(res, i)).as("op %d", i).isEqualTo("applied");
		}
		var row = closeRow(seed, shift);
		assertThat(row.get("expected_cash_paise")).isEqualTo(60_000L);
		assertThat(row.get("variance_paise")).isEqualTo(0L);
		assertThat(openFlags(seed)).isEmpty();
		assertThat(count(seed, "SELECT count(*) FROM audit_log WHERE action = 'shift.closed' AND entity_id = ?", shift)).isEqualTo(1);
	}

	@Test
	void aShortCashCloseIsFlaggedWithTheVarianceButNeverRejected() throws Exception {
		Seed seed = seedTenant();
		var d = new Ops(seed);
		UUID shift = UUID.randomUUID();
		var res = upload(seed,
				d.create("shift", shift, m("openingCashPaise", 50_000, "openedAt", "2026-10-17T09:00:00Z")),
				cash(d, "in", 10_000, "2026-10-17T10:00:00Z"),
				d.create("shift_close", UUID.randomUUID(), m("shiftId", shift, "declaredCashPaise", 59_000,
						"expectedCashPaise", 60_000, "closedAt", "2026-10-17T18:00:00Z")));
		assertThat(statusOf(res, 2)).isEqualTo("flagged");
		assertThat(res.get("results").get(2).get("code").asString()).isEqualTo("cash_variance");
		assertThat(closeRow(seed, shift).get("variance_paise")).isEqualTo(-1_000L);
		assertThat(openFlags(seed)).containsExactly("cash_variance");
		var detail = inTenant(seed.tenant(), () -> jdbc.queryForObject("SELECT detail::text FROM conflict_flag WHERE kind = 'cash_variance'", String.class));
		JsonNode d2 = json.readTree(detail);
		assertThat(d2.get("declaredPaise").asLong()).isEqualTo(59_000);
		assertThat(d2.get("expectedPaise").asLong()).isEqualTo(60_000);
		assertThat(d2.get("variancePaise").asLong()).isEqualTo(-1_000);
	}

	@Test
	void theServerRecomputesExpectedFromThisDevicesCashPaymentsInsideTheShiftWindowOnly() throws Exception {
		Seed seed = seedTenant();
		var d = new Ops(seed);
		var other = new Ops(seed, addDevice(seed), null);
		UUID shift = UUID.randomUUID();
		var res = upload(seed,
				d.create("shift", shift, m("openingCashPaise", 10_000, "openedAt", "2026-10-17T09:00:00Z")),
				cash(d, "in", 5_000, "2026-10-17T08:59:59Z"),   // before the shift: not counted
				cash(d, "in", 7_000, "2026-10-17T09:00:00Z"),   // at the open instant: counted
				cash(d, "out", 1_500, "2026-10-17T12:00:00Z"),
				cash(other, "in", 99_000, "2026-10-17T12:00:00Z"), // another device's drawer: not counted
				d.create("payment", UUID.randomUUID(), m("direction", "in", "mode", "upi", "amountPaise", 8_000, "occurredAt", "2026-10-17T12:00:00Z")),
				cash(d, "in", 3_000, "2026-10-17T18:00:01Z"),   // after the close: not counted
				d.create("shift_close", UUID.randomUUID(), m("shiftId", shift, "declaredCashPaise", 15_500,
						"expectedCashPaise", 99_999, "closedAt", "2026-10-17T18:00:00Z")));
		assertThat(statusOf(res, 7)).isEqualTo("flagged");
		assertThat(res.get("results").get(7).get("code").asString()).contains("shift_expected_mismatch").doesNotContain("cash_variance");
		var row = closeRow(seed, shift);
		assertThat(row.get("expected_cash_paise")).as("10000 + 7000 - 1500").isEqualTo(15_500L);
		assertThat(row.get("client_expected_cash_paise")).isEqualTo(99_999L);
		assertThat(row.get("variance_paise")).isEqualTo(0L);
		assertThat(openFlags(seed)).containsExactly("shift_expected_mismatch");
	}

	@Test
	void aShiftClosesOnceAndTheSecondCloseIsRejectedButTheReplayIsIdempotent() throws Exception {
		Seed seed = seedTenant();
		var d = new Ops(seed);
		UUID shift = UUID.randomUUID();
		UUID close = UUID.randomUUID();
		Map<String, Object> first = d.create("shift_close", close, m("shiftId", shift, "declaredCashPaise", 100, "expectedCashPaise", 100));
		var res = upload(seed, d.create("shift", shift, m("openingCashPaise", 100, "openedAt", "2026-10-17T09:00:00Z")), first,
				d.create("shift_close", UUID.randomUUID(), m("shiftId", shift, "declaredCashPaise", 5, "expectedCashPaise", 100)));
		assertThat(statusOf(res, 1)).isEqualTo("applied");
		assertThat(statusOf(res, 2)).isEqualTo("rejected");
		assertThat(res.get("results").get(2).get("code").asString()).isEqualTo("shift_already_closed");
		// the same close entity under a fresh operation id (a re-queued create) is not a second close
		var again = upload(seed, d.create("shift_close", close, m("shiftId", shift, "declaredCashPaise", 100, "expectedCashPaise", 100)));
		assertThat(statusOf(again, 0)).isEqualTo("applied");
		assertThat(count(seed, "SELECT count(*) FROM shift_close")).isEqualTo(1);
	}

	@Test
	void aCloseForAnUnknownShiftWaitsForTheShiftAndThenApplies() throws Exception {
		Seed seed = seedTenant();
		var d = new Ops(seed);
		UUID shift = UUID.randomUUID();
		var waiting = upload(seed, d.create("shift_close", UUID.randomUUID(), m("shiftId", shift, "declaredCashPaise", 0, "expectedCashPaise", 0)));
		assertThat(statusOf(waiting, 0)).isEqualTo("deferred");
		upload(seed, d.create("shift", shift, m("openingCashPaise", 0, "openedAt", "2026-10-17T09:00:00Z")));
		assertThat(count(seed, "SELECT count(*) FROM shift_close WHERE shift_id = ?", shift)).isEqualTo(1);
	}

	@Test
	void shiftsAreAppendOnlyAndInvalidPayloadsAreRejected() throws Exception {
		Seed seed = seedTenant();
		var d = new Ops(seed);
		UUID shift = UUID.randomUUID();
		var res = upload(seed,
				d.create("shift", shift, m("openingCashPaise", 100, "openedAt", "2026-10-17T09:00:00Z")),
				d.op("shift", shift, "update", m("openingCashPaise", 1)),
				d.create("shift", UUID.randomUUID(), m("openingCashPaise", -5)),
				d.create("shift", UUID.randomUUID(), m()),
				d.create("shift_close", UUID.randomUUID(), m("shiftId", shift, "declaredCashPaise", -1, "expectedCashPaise", 0)));
		assertThat(statusOf(res, 0)).isEqualTo("applied");
		assertThat(res.get("results").get(1).get("code").asString()).isEqualTo("append_only");
		for (int i = 2; i <= 4; i++) {
			assertThat(res.get("results").get(i).get("code").asString()).as("op %d", i).isEqualTo("invalid_payload");
		}
		assertThatThrownBy(() -> inTenant(seed.tenant(), () -> jdbc.update("UPDATE shift SET opening_cash_paise = 0"))).isInstanceOf(DataAccessException.class);
		assertThatThrownBy(() -> inTenant(seed.tenant(), () -> jdbc.update("DELETE FROM shift"))).isInstanceOf(DataAccessException.class);
	}

	@Test
	void closeRowsAreAppendOnlyAndCannotPointAtAnotherTenantsShift() throws Exception {
		Seed a = seedTenant();
		Seed b = seedTenant();
		var d = new Ops(a);
		UUID shift = UUID.randomUUID();
		UUID close = UUID.randomUUID();
		upload(a, d.create("shift", shift, m("openingCashPaise", 0, "openedAt", "2026-10-17T09:00:00Z")),
				d.create("shift_close", close, m("shiftId", shift, "declaredCashPaise", 0, "expectedCashPaise", 0)));
		assertThatThrownBy(() -> inTenant(a.tenant(), () -> jdbc.update("UPDATE shift_close SET declared_cash_paise = 1"))).isInstanceOf(DataAccessException.class);
		assertThat(count(b, "SELECT count(*) FROM shift_close")).isZero();
		assertThatThrownBy(() -> inTenant(b.tenant(), () -> jdbc.update("""
				INSERT INTO shift_close (id, tenant_id, store_id, device_id, shift_id, declared_cash_paise, expected_cash_paise,
				                         client_expected_cash_paise, variance_paise, closed_at, hlc, operation_id)
				VALUES (?, ?, ?, ?, ?, 0, 0, 0, 0, now(), 'x', ?)
				""", UUID.randomUUID(), b.tenant(), b.store(), b.device(), shift, UUID.randomUUID()))).isInstanceOf(DataAccessException.class);
	}
}
