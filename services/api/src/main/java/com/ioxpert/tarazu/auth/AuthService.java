package com.ioxpert.tarazu.auth;

import java.security.MessageDigest;
import java.security.SecureRandom;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import java.util.function.Supplier;

import com.ioxpert.tarazu.identity.AccessPolicy;
import com.ioxpert.tarazu.identity.AuditLog;
import com.ioxpert.tarazu.identity.ContactDirectory;
import com.ioxpert.tarazu.identity.ContactDirectory.Channel;
import com.ioxpert.tarazu.tenancy.ApiException;
import com.ioxpert.tarazu.tenancy.TenantId;
import com.ioxpert.tarazu.tenancy.TenantSession;
import com.ioxpert.tarazu.tenancy.UuidV7;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * OTP onboarding (signup creates the tenant, business, first store and owner) and OTP login. Nothing here has a
 * principal: the tenant is carried in the opaque token the client holds ({@code <tenantId>.<id>}), so RLS is bound
 * before any row is read. Failed attempts are counted in a committed transaction and the error is raised after commit.
 */
@Service
class AuthService {

	private static final Logger log = LoggerFactory.getLogger(AuthService.class);
	private static final SecureRandom RANDOM = new SecureRandom();
	private static final int SIGNUP_HOURS = 1;

	record ChallengeInfo(String channel, String sentTo, Instant expiresAt, Instant resendAfter) {
	}

	record SignupStarted(String signupToken, List<ChallengeInfo> challenges) {
	}

	record SessionView(String token, Instant expiresAt, UUID tenantId, UUID userId, Set<String> roles) {
	}

	record SignupProgress(String status, List<String> remainingChannels, SessionView session, UUID businessId, UUID storeId) {
	}

	record LoginStarted(String challengeToken, Instant expiresAt, Instant resendAfter) {
	}

	private record Pending(Channel channel, String contact, String code, UUID id) {
	}

	private sealed interface Verdict {
		record Ok() implements Verdict {
		}

		record Fail(ApiException error) implements Verdict {
		}
	}

	private final JdbcClient jdbc;
	private final TenantSession tenantSession;
	private final ContactDirectory contacts;
	private final OtpSettings settings;
	private final SessionService sessions;
	private final AuditLog audit;
	private final AccessPolicy access;
	private final List<OtpSender> senders;
	private final TransactionTemplate tx;

	AuthService(JdbcClient jdbc, TenantSession tenantSession, ContactDirectory contacts, OtpSettings settings, SessionService sessions,
			AuditLog audit, AccessPolicy access, List<OtpSender> senders, PlatformTransactionManager tm) {
		this.jdbc = jdbc;
		this.tenantSession = tenantSession;
		this.contacts = contacts;
		this.settings = settings;
		this.sessions = sessions;
		this.audit = audit;
		this.access = access;
		this.senders = senders;
		this.tx = new TransactionTemplate(tm);
	}

	// ---------- config ----------

	record OtpConfig(boolean enabled, String mode, List<String> channels, List<String> signupRequires, int codeTtlMinutes,
			int resendSeconds) {
	}

	OtpConfig config() {
		boolean enabled = contacts.configured() && settings.channels().stream().allMatch(c -> sender(c).isPresent());
		List<String> channels = settings.channels().stream().map(Channel::wire).sorted().toList();
		List<String> requires = switch (settings.mode()) {
			case EMAIL -> List.of("email");
			case PHONE -> List.of("phone");
			case BOTH -> List.of("email", "phone");
			case EITHER -> List.of();
		};
		return new OtpConfig(enabled, settings.mode().name().toLowerCase(), channels, requires, settings.ttlMinutes(), settings.resendSeconds());
	}

	// ---------- signup ----------

	SignupStarted startSignup(String ownerName, String businessName, String email, String phone) {
		requireConfigured();
		String emailN = ContactDirectory.normaliseEmail(email);
		String phoneN = ContactDirectory.normalisePhone(phone);
		if (email != null && !email.isBlank() && emailN == null) {
			throw ApiException.badRequest("invalid_contact", "That email address is not valid");
		}
		if (phone != null && !phone.isBlank() && phoneN == null) {
			throw ApiException.badRequest("invalid_contact", "That phone number is not valid (Indian mobile or +country number)");
		}
		List<Channel> required = new ArrayList<>();
		boolean wantEmail = switch (settings.mode()) {
			case EMAIL, BOTH -> true;
			case PHONE -> false;
			case EITHER -> emailN != null;
		};
		boolean wantPhone = switch (settings.mode()) {
			case PHONE, BOTH -> true;
			case EMAIL -> false;
			case EITHER -> phoneN != null;
		};
		if (wantEmail) {
			if (emailN == null) {
				throw ApiException.badRequest("contact_required", "An email address is required");
			}
			required.add(Channel.EMAIL);
		}
		if (wantPhone) {
			if (phoneN == null) {
				throw ApiException.badRequest("contact_required", "A phone number is required");
			}
			required.add(Channel.PHONE);
		}
		if (required.isEmpty()) {
			throw ApiException.badRequest("contact_required", "Give an email address or a phone number");
		}
		for (Channel c : required) {
			String contact = c == Channel.EMAIL ? emailN : phoneN;
			requireSender(c);
			if (!throttle(c, contact)) {
				throw tooMany();
			}
			if (inTx(() -> contacts.lookup(c, contact)).isPresent()) {
				throw ApiException.conflict("contact_in_use", "That " + c.wire() + " already has an account; sign in instead");
			}
		}

		UUID tenantId = UuidV7.next();
		UUID signupId = UuidV7.next();
		List<Pending> toSend = new ArrayList<>();
		List<ChallengeInfo> infos = new ArrayList<>();
		tx.executeWithoutResult(s -> {
			tenantSession.bind(new TenantId(tenantId));
			jdbc.sql("""
					INSERT INTO signup_request (tenant_id, id, owner_name, business_name, email, phone, required_channels, expires_at)
					VALUES (:t, :id, :owner, :biz, :email, :phone, :req, :exp)
					""").param("t", tenantId).param("id", signupId).param("owner", ownerName.trim()).param("biz", businessName.trim())
					.param("email", wantEmail ? emailN : null).param("phone", wantPhone ? phoneN : null)
					.param("req", required.stream().map(Channel::wire).toArray(String[]::new))
					.param("exp", java.sql.Timestamp.from(Instant.now().plus(SIGNUP_HOURS, ChronoUnit.HOURS))).update();
			for (Channel c : required) {
				String contact = c == Channel.EMAIL ? emailN : phoneN;
				toSend.add(newChallenge(tenantId, "signup", c, contact, signupId, null, infos));
			}
		});
		deliver(toSend);
		return new SignupStarted(tenantId + "." + signupId, infos);
	}

	void resendSignup(String token, String channelWire) {
		requireConfigured();
		UUID[] ids = parse(token);
		Channel channel = channelOf(channelWire);
		List<Pending> toSend = new ArrayList<>();
		String[] contactHolder = new String[1];
		tx.executeWithoutResult(s -> {
			tenantSession.bind(new TenantId(ids[0]));
			var row = jdbc.sql("SELECT email, phone, required_channels, status, expires_at > now() AS live FROM signup_request WHERE id = :id FOR UPDATE")
					.param("id", ids[1]).query((rs, n) -> Map.of("email", String.valueOf(rs.getString("email")), "phone", String.valueOf(rs.getString("phone")),
							"required", String.join(",", (String[]) rs.getArray("required_channels").getArray()), "status", rs.getString("status"),
							"live", String.valueOf(rs.getBoolean("live"))))
					.optional().orElseThrow(() -> ApiException.notFound("signup_not_found", "Unknown or expired sign-up"));
			if (!"pending".equals(row.get("status")) || !"true".equals(row.get("live"))) {
				throw ApiException.conflict("signup_closed", "This sign-up is finished or expired; start again");
			}
			if (!List.of(row.get("required").split(",")).contains(channel.wire())) {
				throw ApiException.badRequest("channel_not_required", "That channel is not part of this sign-up");
			}
			contactHolder[0] = row.get(channel.wire());
			Instant latest = jdbc.sql("SELECT max(created_at) FROM otp_challenge WHERE signup_id = :s AND channel = :c")
					.param("s", ids[1]).param("c", channel.wire()).query(java.sql.Timestamp.class).optional().map(java.sql.Timestamp::toInstant).orElse(null);
			if (latest != null && latest.plusSeconds(settings.resendSeconds()).isAfter(Instant.now())) {
				throw new ApiException(org.springframework.http.HttpStatus.TOO_MANY_REQUESTS, "resend_too_soon", "Wait a moment before asking for another code");
			}
			toSend.add(newChallenge(ids[0], "signup", channel, contactHolder[0], ids[1], null, new ArrayList<>()));
		});
		if (!throttle(channel, contactHolder[0])) {
			throw tooMany();
		}
		deliver(toSend);
	}

	SignupProgress verifySignup(String token, String channelWire, String code) {
		requireConfigured();
		UUID[] ids = parse(token);
		Channel channel = channelOf(channelWire);
		record Outcome(Verdict verdict, SignupProgress progress) {
		}
		Outcome out = tx.execute(s -> {
			tenantSession.bind(new TenantId(ids[0]));
			var signup = jdbc.sql("""
					SELECT owner_name, business_name, email, phone, required_channels, verified_channels, status, expires_at > now() AS live
					FROM signup_request WHERE id = :id FOR UPDATE
					""").param("id", ids[1]).query((rs, n) -> new String[] { rs.getString("owner_name"), rs.getString("business_name"),
							rs.getString("email"), rs.getString("phone"), String.join(",", (String[]) rs.getArray("required_channels").getArray()),
							String.join(",", (String[]) rs.getArray("verified_channels").getArray()), rs.getString("status"),
							String.valueOf(rs.getBoolean("live")) }).optional().orElse(null);
			if (signup == null) {
				return new Outcome(new Verdict.Fail(ApiException.notFound("signup_not_found", "Unknown or expired sign-up")), null);
			}
			if (!"pending".equals(signup[6]) || !"true".equals(signup[7])) {
				return new Outcome(new Verdict.Fail(ApiException.conflict("signup_closed", "This sign-up is finished or expired; start again")), null);
			}
			List<String> required = List.of(signup[4].split(","));
			List<String> verified = signup[5].isEmpty() ? new ArrayList<>() : new ArrayList<>(List.of(signup[5].split(",")));
			if (!required.contains(channel.wire())) {
				return new Outcome(new Verdict.Fail(ApiException.badRequest("channel_not_required", "That channel is not part of this sign-up")), null);
			}
			if (!verified.contains(channel.wire())) {
				Verdict v = check(ids[0], channel, ids[1], code);
				if (v instanceof Verdict.Fail) {
					return new Outcome(v, null);
				}
				verified.add(channel.wire());
				jdbc.sql("UPDATE signup_request SET verified_channels = :v WHERE id = :id").param("v", verified.toArray(String[]::new))
						.param("id", ids[1]).update();
			}
			List<String> remaining = required.stream().filter(c -> !verified.contains(c)).toList();
			if (!remaining.isEmpty()) {
				return new Outcome(new Verdict.Ok(), new SignupProgress("pending", remaining, null, null, null));
			}
			return new Outcome(new Verdict.Ok(), complete(ids[0], ids[1], signup));
		});
		if (out.verdict() instanceof Verdict.Fail f) {
			throw f.error();
		}
		return out.progress();
	}

	/** Creates the tenant and its first business, store and owner from a fully verified sign-up. */
	private SignupProgress complete(UUID tenantId, UUID signupId, String[] signup) {
		UUID business = UuidV7.next();
		UUID store = UuidV7.next();
		UUID owner = UuidV7.next();
		jdbc.sql("INSERT INTO tenant (id, name) VALUES (:t, :n)").param("t", tenantId).param("n", signup[1]).update();
		jdbc.sql("INSERT INTO business (id, tenant_id, name) VALUES (:id, :t, :n)").param("id", business).param("t", tenantId).param("n", signup[1]).update();
		jdbc.sql("INSERT INTO store (id, tenant_id, business_id, name) VALUES (:id, :t, :b, 'Main')").param("id", store).param("t", tenantId).param("b", business).update();
		jdbc.sql("INSERT INTO app_user (id, tenant_id, display_name, email, phone) VALUES (:id, :t, :n, :e, :p)")
				.param("id", owner).param("t", tenantId).param("n", signup[0]).param("e", signup[2]).param("p", signup[3]).update();
		jdbc.sql("INSERT INTO user_role (tenant_id, user_id, role) VALUES (:t, :u, 'owner')").param("t", tenantId).param("u", owner).update();
		if (signup[2] != null && !contacts.register(Channel.EMAIL, signup[2], tenantId, owner)
				|| signup[3] != null && !contacts.register(Channel.PHONE, signup[3], tenantId, owner)) {
			throw ApiException.conflict("contact_in_use", "That contact was claimed by another account while you were signing up");
		}
		jdbc.sql("UPDATE signup_request SET status = 'completed' WHERE id = :id").param("id", signupId).update();
		audit.recordFor(AuditLog.Entry.of("tenant.onboarded", "tenant", tenantId, null)
				.withDetails(Map.of("channels", signup[4], "ownerUserId", owner.toString())).byOperation(null, owner, null), tenantId);
		var session = sessions.issue(tenantId, owner);
		return new SignupProgress("completed", List.of(), new SessionView(session.token(), session.expiresAt(), tenantId, owner, Set.of("owner")), business, store);
	}

	// ---------- login ----------

	LoginStarted startLogin(String channelWire, String contactRaw) {
		requireConfigured();
		Channel channel = channelOf(channelWire);
		if (!settings.channels().contains(channel)) {
			throw ApiException.badRequest("channel_not_enabled", "Sign-in by " + channel.wire() + " is not enabled");
		}
		String contact = ContactDirectory.normalise(channel, contactRaw);
		if (contact == null) {
			throw ApiException.badRequest("invalid_contact", "That " + channel.wire() + " is not valid");
		}
		requireSender(channel);
		if (!throttle(channel, contact)) {
			throw tooMany();
		}
		Instant expires = Instant.now().plus(settings.ttlMinutes(), ChronoUnit.MINUTES);
		Instant resend = Instant.now().plusSeconds(settings.resendSeconds());
		Optional<ContactDirectory.Owner> owner = inTx(() -> contacts.lookup(channel, contact));
		if (owner.isEmpty()) {
			// identical answer for unknown contacts: no account enumeration
			return new LoginStarted(UuidV7.next() + "." + UuidV7.next(), expires, resend);
		}
		UUID tenantId = owner.get().tenantId();
		List<Pending> toSend = new ArrayList<>();
		List<ChallengeInfo> infos = new ArrayList<>();
		UUID[] challengeId = new UUID[1];
		tx.executeWithoutResult(s -> {
			tenantSession.bind(new TenantId(tenantId));
			boolean active = jdbc.sql("SELECT count(*) FROM app_user WHERE id = :u AND status = 'active'").param("u", owner.get().userId()).query(Long.class).single() > 0;
			Instant latest = jdbc.sql("SELECT max(created_at) FROM otp_challenge WHERE user_id = :u AND channel = :c AND purpose = 'login'")
					.param("u", owner.get().userId()).param("c", channel.wire()).query(java.sql.Timestamp.class).optional()
					.map(java.sql.Timestamp::toInstant).orElse(null);
			if (active && (latest == null || latest.plusSeconds(settings.resendSeconds()).isBefore(Instant.now()))) {
				Pending p = newChallenge(tenantId, "login", channel, contact, null, owner.get().userId(), infos);
				toSend.add(p);
				challengeId[0] = p.id();
			}
			else if (active) {
				challengeId[0] = UUID.fromString(lastChallenge(tenantId, owner.get().userId(), channel));
			}
		});
		deliver(toSend);
		UUID cid = challengeId[0] != null ? challengeId[0] : UuidV7.next();
		return new LoginStarted(tenantId + "." + cid, expires, resend);
	}

	private String lastChallenge(UUID tenantId, UUID userId, Channel channel) {
		return jdbc.sql("SELECT id FROM otp_challenge WHERE user_id = :u AND channel = :c AND purpose = 'login' ORDER BY created_at DESC LIMIT 1")
				.param("u", userId).param("c", channel.wire()).query(UUID.class).single().toString();
	}

	SessionView verifyLogin(String token, String code) {
		requireConfigured();
		UUID[] ids = parse(token);
		record Outcome(Verdict verdict, SessionView session) {
		}
		Outcome out = tx.execute(s -> {
			tenantSession.bind(new TenantId(ids[0]));
			var ch = jdbc.sql("SELECT user_id, channel FROM otp_challenge WHERE id = :id AND purpose = 'login'").param("id", ids[1])
					.query((rs, n) -> new Object[] { rs.getObject("user_id", UUID.class), rs.getString("channel") }).optional().orElse(null);
			if (ch == null) {
				return new Outcome(new Verdict.Fail(invalidCode()), null);
			}
			Verdict v = checkById(ids[0], ids[1], code);
			if (v instanceof Verdict.Fail) {
				return new Outcome(v, null);
			}
			UUID user = (UUID) ch[0];
			boolean active = jdbc.sql("SELECT count(*) FROM app_user WHERE id = :u AND status = 'active'").param("u", user).query(Long.class).single() > 0;
			if (!active) {
				return new Outcome(new Verdict.Fail(invalidCode()), null);
			}
			var session = sessions.issue(ids[0], user);
			audit.recordFor(AuditLog.Entry.of("auth.login", "app_user", user, null).withDetails(Map.of("channel", (String) ch[1])).byOperation(null, user, null), ids[0]);
			return new Outcome(new Verdict.Ok(), new SessionView(session.token(), session.expiresAt(), ids[0], user, access.rolesOf(user)));
		});
		if (out.verdict() instanceof Verdict.Fail f) {
			throw f.error();
		}
		return out.session();
	}

	// ---------- logout ----------

	void logout(String authorizationHeader) {
		String[] parts = SessionTokenAuthenticator.parse(authorizationHeader);
		if (parts == null) {
			throw ApiException.badRequest("not_a_session", "Only a signed-in session can sign out; revoke a device from the device list");
		}
		tx.executeWithoutResult(s -> {
			tenantSession.bind(new TenantId(UUID.fromString(parts[1])));
			jdbc.sql("UPDATE auth_session SET revoked_at = now() WHERE id = :id AND revoked_at IS NULL").param("id", UUID.fromString(parts[2])).update();
		});
	}

	// ---------- shared ----------

	/** Creates a code, expiring earlier unused ones for the same target. Returns what to send after commit. */
	private Pending newChallenge(UUID tenantId, String purpose, Channel channel, String contact, UUID signupId, UUID userId, List<ChallengeInfo> infos) {
		UUID id = UuidV7.next();
		String code = "%06d".formatted(RANDOM.nextInt(1_000_000));
		jdbc.sql("""
				UPDATE otp_challenge SET consumed_at = now()
				WHERE consumed_at IS NULL AND channel = :c AND purpose = :p AND (signup_id = :s OR user_id = :u)
				""").param("c", channel.wire()).param("p", purpose).param("s", signupId).param("u", userId).update();
		Instant expires = Instant.now().plus(settings.ttlMinutes(), ChronoUnit.MINUTES);
		jdbc.sql("""
				INSERT INTO otp_challenge (tenant_id, id, purpose, channel, signup_id, user_id, code_hash, expires_at)
				VALUES (:t, :id, :p, :c, :s, :u, :h, :exp)
				""").param("t", tenantId).param("id", id).param("p", purpose).param("c", channel.wire()).param("s", signupId).param("u", userId)
				.param("h", contacts.keyedHash("otp", tenantId + ":" + id + ":" + code)).param("exp", java.sql.Timestamp.from(expires)).update();
		infos.add(new ChallengeInfo(channel.wire(), mask(channel, contact), expires, Instant.now().plusSeconds(settings.resendSeconds())));
		return new Pending(channel, contact, code, id);
	}

	private Verdict check(UUID tenantId, Channel channel, UUID signupId, String code) {
		UUID id = jdbc.sql("SELECT id FROM otp_challenge WHERE signup_id = :s AND channel = :c AND consumed_at IS NULL ORDER BY created_at DESC LIMIT 1")
				.param("s", signupId).param("c", channel.wire()).query(UUID.class).optional().orElse(null);
		if (id == null) {
			return new Verdict.Fail(new ApiException(org.springframework.http.HttpStatus.GONE, "code_expired", "That code has expired; ask for a new one"));
		}
		return checkById(tenantId, id, code);
	}

	private Verdict checkById(UUID tenantId, UUID id, String code) {
		var row = jdbc.sql("SELECT code_hash, attempts, expires_at > now() AS live, consumed_at IS NOT NULL AS used FROM otp_challenge WHERE id = :id FOR UPDATE")
				.param("id", id).query((rs, n) -> new Object[] { rs.getBytes("code_hash"), rs.getInt("attempts"), rs.getBoolean("live"), rs.getBoolean("used") })
				.optional().orElse(null);
		if (row == null || (Boolean) row[3] || !(Boolean) row[2]) {
			return new Verdict.Fail(new ApiException(org.springframework.http.HttpStatus.GONE, "code_expired", "That code has expired; ask for a new one"));
		}
		if ((Integer) row[1] >= settings.maxAttempts()) {
			return new Verdict.Fail(tooManyAttempts());
		}
		byte[] given = contacts.keyedHash("otp", tenantId + ":" + id + ":" + (code == null ? "" : code.trim()));
		if (MessageDigest.isEqual(given, (byte[]) row[0])) {
			jdbc.sql("UPDATE otp_challenge SET consumed_at = now() WHERE id = :id").param("id", id).update();
			return new Verdict.Ok();
		}
		int attempts = (Integer) row[1] + 1;
		jdbc.sql("UPDATE otp_challenge SET attempts = :a WHERE id = :id").param("a", attempts).param("id", id).update();
		return new Verdict.Fail(attempts >= settings.maxAttempts() ? tooManyAttempts() : invalidCode());
	}

	private void deliver(List<Pending> sends) {
		for (Pending p : sends) {
			try {
				sender(p.channel()).orElseThrow().send(p.channel(), p.contact(), p.code());
			}
			catch (RuntimeException ex) {
				log.error("OTP delivery on {} failed", p.channel().wire(), ex);
				throw new ApiException(org.springframework.http.HttpStatus.BAD_GATEWAY, "otp_delivery_failed", "We could not send the code; try again shortly");
			}
		}
	}

	private Optional<OtpSender> sender(Channel channel) {
		return senders.stream().filter(s -> s.supports(channel)).findFirst();
	}

	private void requireSender(Channel channel) {
		if (sender(channel).isEmpty()) {
			throw new ApiException(org.springframework.http.HttpStatus.SERVICE_UNAVAILABLE, "otp_channel_unavailable", "No " + channel.wire() + " delivery is configured");
		}
	}

	private void requireConfigured() {
		if (!contacts.configured()) {
			throw new ApiException(org.springframework.http.HttpStatus.SERVICE_UNAVAILABLE, "otp_not_configured", "OTP sign-in is not configured for this deployment");
		}
	}

	private boolean throttle(Channel channel, String contact) {
		return Boolean.TRUE.equals(tx.execute(s -> contacts.allowOtpRequest(channel, contact, settings.maxPerHour(), 60)));
	}

	private <T> T inTx(Supplier<T> work) {
		return tx.execute(s -> work.get());
	}

	private static UUID[] parse(String token) {
		try {
			String[] p = token.split("\\.");
			return new UUID[] { UUID.fromString(p[0]), UUID.fromString(p[1]) };
		}
		catch (RuntimeException ex) {
			throw ApiException.notFound("token_invalid", "Unknown or expired token");
		}
	}

	private static Channel channelOf(String wire) {
		return Channel.fromWire(wire).orElseThrow(() -> ApiException.badRequest("invalid_channel", "Channel must be email or phone"));
	}

	private static ApiException tooMany() {
		return new ApiException(org.springframework.http.HttpStatus.TOO_MANY_REQUESTS, "too_many_requests", "Too many codes requested for this contact; try again later");
	}

	private static ApiException tooManyAttempts() {
		return new ApiException(org.springframework.http.HttpStatus.TOO_MANY_REQUESTS, "too_many_attempts", "Too many wrong codes; ask for a new one");
	}

	private static ApiException invalidCode() {
		return ApiException.unauthorized("invalid_code", "That code is not right");
	}

	private static String mask(Channel channel, String contact) {
		if (channel == Channel.EMAIL) {
			int at = contact.indexOf('@');
			return contact.charAt(0) + "***" + contact.substring(at);
		}
		return contact.substring(0, Math.min(3, contact.length())) + "*******" + contact.substring(Math.max(0, contact.length() - 2));
	}
}
