package com.ioxpert.tarazu.auth;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;

import com.ioxpert.tarazu.identity.ContactDirectory.Channel;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.stereotype.Component;
import tools.jackson.databind.json.JsonMapper;

/**
 * Sends SMS codes through any HTTPS gateway that takes a JSON POST (MSG91, Twilio-style proxies, an in-house relay).
 * Configure {@code tarazu.auth.otp.sms.url}, an optional auth header, and a JSON {@code body-template} using the
 * placeholders {@code {{to}}} (E.164), {@code {{message}}} and {@code {{templateId}}} (DLT template id). Values are JSON-escaped.
 */
@Component
@ConditionalOnProperty("tarazu.auth.otp.sms.url")
class HttpSmsOtpSender implements OtpSender {

	private final HttpClient client = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(3)).build();
	private final JsonMapper json;
	private final OtpMessages messages;
	private final URI url;
	private final String authHeader;
	private final String authValue;
	private final String bodyTemplate;
	private final String templateId;

	HttpSmsOtpSender(JsonMapper json, OtpMessages messages, @Value("${tarazu.auth.otp.sms.url}") String url,
			@Value("${tarazu.auth.otp.sms.auth-header:Authorization}") String authHeader,
			@Value("${tarazu.auth.otp.sms.auth-value:}") String authValue,
			@Value("${tarazu.auth.otp.sms.body-template:{\"to\":\"{{to}}\",\"message\":\"{{message}}\",\"templateId\":\"{{templateId}}\"}}") String bodyTemplate,
			@Value("${tarazu.auth.otp.sms.template-id:}") String templateId) {
		this.json = json;
		this.messages = messages;
		this.url = URI.create(url);
		if (!"https".equals(this.url.getScheme()) && !"localhost".equals(this.url.getHost()) && !"127.0.0.1".equals(this.url.getHost())) {
			throw new IllegalStateException("tarazu.auth.otp.sms.url must be https");
		}
		this.authHeader = authHeader;
		this.authValue = authValue;
		this.bodyTemplate = bodyTemplate;
		this.templateId = templateId;
	}

	@Override
	public boolean supports(Channel channel) {
		return channel == Channel.PHONE;
	}

	@Override
	public void send(Channel channel, String contact, String code) {
		String body = bodyTemplate.replace("{{to}}", esc(contact)).replace("{{message}}", esc(messages.sms(code)))
				.replace("{{templateId}}", esc(templateId));
		HttpRequest.Builder req = HttpRequest.newBuilder(url).timeout(Duration.ofSeconds(5))
				.header("Content-Type", "application/json").POST(HttpRequest.BodyPublishers.ofString(body));
		if (!authValue.isBlank()) {
			req.header(authHeader, authValue);
		}
		try {
			HttpResponse<Void> res = client.send(req.build(), HttpResponse.BodyHandlers.discarding());
			if (res.statusCode() / 100 != 2) {
				throw new IllegalStateException("SMS gateway answered HTTP " + res.statusCode());
			}
		}
		catch (IOException ex) {
			throw new IllegalStateException("SMS gateway unreachable", ex);
		}
		catch (InterruptedException ex) {
			Thread.currentThread().interrupt();
			throw new IllegalStateException("SMS send interrupted", ex);
		}
	}

	/** JSON string content without the surrounding quotes. */
	private String esc(String value) {
		String quoted = json.writeValueAsString(value);
		return quoted.substring(1, quoted.length() - 1);
	}
}
