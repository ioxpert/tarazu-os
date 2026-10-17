package com.ioxpert.tarazu.auth;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

/** Wording of the code messages. SMS text must match the template registered with the operator (India DLT). */
@Component
class OtpMessages {

	private final OtpSettings settings;
	private final String smsTemplate;
	private final String emailSubject;

	OtpMessages(OtpSettings settings,
			@Value("${tarazu.auth.otp.sms.message:{code} is your Tarazu OS verification code. It is valid for {minutes} minutes. Do not share it.}") String smsTemplate,
			@Value("${tarazu.auth.otp.email.subject:Your Tarazu OS verification code}") String emailSubject) {
		this.settings = settings;
		this.smsTemplate = smsTemplate;
		this.emailSubject = emailSubject;
	}

	String sms(String code) {
		return fill(smsTemplate, code);
	}

	String emailSubject() {
		return emailSubject;
	}

	String emailBody(String code) {
		return fill("Your Tarazu OS verification code is {code}.\n\nIt is valid for {minutes} minutes. "
				+ "If you did not ask for it, ignore this message; nobody can sign in without the code.", code);
	}

	private String fill(String template, String code) {
		return template.replace("{code}", code).replace("{minutes}", String.valueOf(settings.ttlMinutes()));
	}
}
