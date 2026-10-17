package com.ioxpert.tarazu.auth;

import com.ioxpert.tarazu.identity.ContactDirectory.Channel;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.stereotype.Component;

/** DEV ONLY: writes codes to the log. Exists only with {@code tarazu.auth.otp.dev-log-codes=true}; never in production. */
@Component
@ConditionalOnProperty(name = "tarazu.auth.otp.dev-log-codes", havingValue = "true")
class LoggingOtpSender implements OtpSender {

	private static final Logger log = LoggerFactory.getLogger(LoggingOtpSender.class);

	@Override
	public boolean supports(Channel channel) {
		return true;
	}

	@Override
	public void send(Channel channel, String contact, String code) {
		log.warn("DEV OTP for {} {}: {}", channel.wire(), contact, code);
	}
}
