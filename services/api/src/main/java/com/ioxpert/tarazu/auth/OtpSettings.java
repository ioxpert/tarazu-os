package com.ioxpert.tarazu.auth;

import java.util.EnumSet;
import java.util.Set;

import com.ioxpert.tarazu.identity.ContactDirectory.Channel;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

/**
 * Which contact proof onboarding needs, configurable per deployment with {@code tarazu.auth.otp.mode}:
 * EMAIL (email only), PHONE (phone only), EITHER (the owner gives email, phone or both; every contact given must be
 * verified) or BOTH (email and phone are both required and both verified). Login works on any enabled channel
 * the account has.
 */
@Component
public class OtpSettings {

	public enum Mode { EMAIL, PHONE, EITHER, BOTH }

	private volatile Mode mode;
	// Always read through the accessors: Spring Modulith may wrap this public bean in a proxy, whose fields are empty.
	private volatile int ttlMinutes;
	private volatile int maxAttempts;
	private volatile int resendSeconds;
	private volatile int maxPerHour;
	private volatile int sessionDays;

	OtpSettings(@Value("${tarazu.auth.otp.mode:EITHER}") Mode mode, @Value("${tarazu.auth.otp.ttl-minutes:10}") int ttlMinutes,
			@Value("${tarazu.auth.otp.max-attempts:5}") int maxAttempts, @Value("${tarazu.auth.otp.resend-seconds:60}") int resendSeconds,
			@Value("${tarazu.auth.otp.max-per-hour:5}") int maxPerHour, @Value("${tarazu.auth.session-days:30}") int sessionDays) {
		this.mode = mode;
		this.ttlMinutes = ttlMinutes;
		this.maxAttempts = maxAttempts;
		this.resendSeconds = resendSeconds;
		this.maxPerHour = maxPerHour;
		this.sessionDays = sessionDays;
	}

	public Mode mode() {
		return mode;
	}

	public int ttlMinutes() {
		return ttlMinutes;
	}

	public int maxAttempts() {
		return maxAttempts;
	}

	public int resendSeconds() {
		return resendSeconds;
	}

	public int maxPerHour() {
		return maxPerHour;
	}

	public int sessionDays() {
		return sessionDays;
	}

	/** Runtime overrides (tests, and a future admin setting). */
	public void setMode(Mode mode) {
		this.mode = mode;
	}

	public void setMaxAttempts(int maxAttempts) {
		this.maxAttempts = maxAttempts;
	}

	public void setResendSeconds(int resendSeconds) {
		this.resendSeconds = resendSeconds;
	}

	public void setMaxPerHour(int maxPerHour) {
		this.maxPerHour = maxPerHour;
	}

	/** Channels a code may be sent on (signup and login). */
	public Set<Channel> channels() {
		return switch (mode) {
			case EMAIL -> EnumSet.of(Channel.EMAIL);
			case PHONE -> EnumSet.of(Channel.PHONE);
			case EITHER, BOTH -> EnumSet.allOf(Channel.class);
		};
	}
}
