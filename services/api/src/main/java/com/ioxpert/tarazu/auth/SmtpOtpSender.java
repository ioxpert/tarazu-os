package com.ioxpert.tarazu.auth;

import com.ioxpert.tarazu.identity.ContactDirectory.Channel;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.mail.SimpleMailMessage;
import org.springframework.mail.javamail.JavaMailSender;
import org.springframework.stereotype.Component;

/** Sends email codes over SMTP. Active when {@code spring.mail.host} is set (SES, Postmark, any relay). */
@Component
@ConditionalOnProperty("spring.mail.host")
class SmtpOtpSender implements OtpSender {

	private final JavaMailSender mail;
	private final OtpMessages messages;
	private final String from;

	SmtpOtpSender(JavaMailSender mail, OtpMessages messages, @Value("${tarazu.auth.otp.email.from:}") String from) {
		if (from.isBlank()) {
			throw new IllegalStateException("tarazu.auth.otp.email.from is required when spring.mail.host is set");
		}
		this.mail = mail;
		this.messages = messages;
		this.from = from;
	}

	@Override
	public boolean supports(Channel channel) {
		return channel == Channel.EMAIL;
	}

	@Override
	public void send(Channel channel, String contact, String code) {
		SimpleMailMessage m = new SimpleMailMessage();
		m.setFrom(from);
		m.setTo(contact);
		m.setSubject(messages.emailSubject());
		m.setText(messages.emailBody(code));
		mail.send(m);
	}
}
