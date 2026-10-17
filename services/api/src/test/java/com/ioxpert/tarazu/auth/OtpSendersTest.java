package com.ioxpert.tarazu.auth;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

import com.ioxpert.tarazu.identity.ContactDirectory.Channel;
import com.sun.net.httpserver.HttpServer;
import jakarta.mail.internet.MimeMessage;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.mail.SimpleMailMessage;
import org.springframework.mail.javamail.JavaMailSenderImpl;
import tools.jackson.databind.json.JsonMapper;

/** The two delivery adapters against a real local HTTP server and a capturing mail sender. */
class OtpSendersTest {

	private final JsonMapper json = JsonMapper.builder().build();
	private OtpSettings settings;
	private OtpMessages messages;
	private HttpServer server;
	private final List<String> bodies = new ArrayList<>();
	private final List<String> auth = new ArrayList<>();
	private volatile int status = 200;

	@BeforeEach
	void start() throws Exception {
		settings = new OtpSettings(OtpSettings.Mode.EITHER, 10, 5, 60, 5, 30);
		messages = new OtpMessages(settings, "{code} is your Tarazu OS verification code. It is valid for {minutes} minutes. Do not share it.",
				"Your Tarazu OS verification code");
		server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
		server.createContext("/sms", ex -> {
			bodies.add(new String(ex.getRequestBody().readAllBytes(), StandardCharsets.UTF_8));
			auth.add(String.valueOf(ex.getRequestHeaders().getFirst("X-Api-Key")));
			ex.sendResponseHeaders(status, -1);
			ex.close();
		});
		server.start();
	}

	@AfterEach
	void stop() {
		server.stop(0);
	}

	private HttpSmsOtpSender sms(String template) {
		return new HttpSmsOtpSender(json, messages, "http://127.0.0.1:" + server.getAddress().getPort() + "/sms", "X-Api-Key", "secret-key",
				template, "DLT-123");
	}

	@Test
	void smsPostsTheFilledTemplateWithTheGatewayKey() {
		sms("{\"to\":\"{{to}}\",\"message\":\"{{message}}\",\"templateId\":\"{{templateId}}\"}").send(Channel.PHONE, "+919876543210", "123456");
		var body = json.readTree(bodies.get(0));
		assertThat(body.get("to").asString()).isEqualTo("+919876543210");
		assertThat(body.get("message").asString()).isEqualTo("123456 is your Tarazu OS verification code. It is valid for 10 minutes. Do not share it.");
		assertThat(body.get("templateId").asString()).isEqualTo("DLT-123");
		assertThat(auth).containsExactly("secret-key");
	}

	@Test
	void valuesAreJsonEscapedSoAContactCannotBreakOutOfTheBody() {
		sms("{\"to\":\"{{to}}\"}").send(Channel.PHONE, "+91\",\"admin\":\"true", "123456");
		var body = json.readTree(bodies.get(0));
		assertThat(body.get("to").asString()).isEqualTo("+91\",\"admin\":\"true");
		assertThat(body.has("admin")).isFalse();
	}

	@Test
	void aGatewayErrorSurfacesSoTheCallerCanTellTheUser() {
		status = 500;
		assertThatThrownBy(() -> sms("{\"to\":\"{{to}}\"}").send(Channel.PHONE, "+919876543210", "123456"))
				.isInstanceOf(IllegalStateException.class).hasMessageContaining("500");
	}

	@Test
	void plainHttpToARemoteHostIsRefused() {
		assertThatThrownBy(() -> new HttpSmsOtpSender(json, messages, "http://sms.example.com/send", "Authorization", "k", "{}", ""))
				.isInstanceOf(IllegalStateException.class);
	}

	@Test
	void emailGoesOutFromTheConfiguredAddress() {
		List<SimpleMailMessage> sent = new ArrayList<>();
		var mail = new JavaMailSenderImpl() {
			@Override
			public void send(SimpleMailMessage... messages) {
				sent.addAll(List.of(messages));
			}

			@Override
			public void send(MimeMessage... mimeMessages) {
				throw new AssertionError("plain text expected");
			}
		};
		var sender = new SmtpOtpSender(mail, messages, "no-reply@tarazu.example");
		sender.send(Channel.EMAIL, "asha@example.in", "654321");
		assertThat(sent).hasSize(1);
		assertThat(sent.get(0).getFrom()).isEqualTo("no-reply@tarazu.example");
		assertThat(sent.get(0).getTo()).containsExactly("asha@example.in");
		assertThat(sent.get(0).getText()).contains("654321").contains("10 minutes");
		assertThat(sender.supports(Channel.EMAIL)).isTrue();
		assertThat(sender.supports(Channel.PHONE)).isFalse();
		assertThatThrownBy(() -> new SmtpOtpSender(mail, messages, "")).isInstanceOf(IllegalStateException.class);
	}
}
