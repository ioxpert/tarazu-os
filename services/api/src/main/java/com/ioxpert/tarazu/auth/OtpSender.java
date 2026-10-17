package com.ioxpert.tarazu.auth;

import com.ioxpert.tarazu.identity.ContactDirectory.Channel;

/**
 * Delivers a one-time code. Production SMS (DLT-registered template) and email providers implement this; the
 * gateway picks the first sender that supports the channel. With none for a channel, OTP on that channel answers 503.
 */
public interface OtpSender {

	boolean supports(Channel channel);

	void send(Channel channel, String contact, String code);
}
