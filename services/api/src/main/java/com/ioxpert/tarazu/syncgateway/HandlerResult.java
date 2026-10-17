package com.ioxpert.tarazu.syncgateway;

/**
 * What a handler decided. A rejected operation is rolled back, recorded with its code, and acknowledged so the
 * device queue keeps moving; its raw payload stays in the operation log. Policy violations on documents that
 * already exist on a device (missing approval, wrong tax rate) are NOT rejections: apply and flag instead.
 */
public sealed interface HandlerResult {

	record Applied() implements HandlerResult {
	}

	record Rejected(String code, String detail) implements HandlerResult {
	}

	static HandlerResult applied() {
		return new Applied();
	}

	static HandlerResult rejected(String code, String detail) {
		return new Rejected(code, detail);
	}
}
