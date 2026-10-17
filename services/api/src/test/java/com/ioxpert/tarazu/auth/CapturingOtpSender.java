package com.ioxpert.tarazu.auth;

import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

import com.ioxpert.tarazu.identity.ContactDirectory.Channel;
import org.springframework.stereotype.Component;

/** Test sender: remembers the last code sent to each contact instead of delivering it. */
@Component
public class CapturingOtpSender implements OtpSender {

	private static final Map<String, String> LAST = new ConcurrentHashMap<>();

	@Override
	public boolean supports(Channel channel) {
		return true;
	}

	@Override
	public void send(Channel channel, String contact, String code) {
		LAST.put(channel.wire() + ":" + contact, code);
	}

	public static String lastCode(Channel channel, String normalisedContact) {
		return LAST.get(channel.wire() + ":" + normalisedContact);
	}

	public static void forget(Channel channel, String normalisedContact) {
		LAST.remove(channel.wire() + ":" + normalisedContact);
	}
}
