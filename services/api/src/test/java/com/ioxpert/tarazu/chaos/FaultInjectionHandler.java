package com.ioxpert.tarazu.chaos;

import java.util.concurrent.atomic.AtomicBoolean;

import com.ioxpert.tarazu.syncgateway.EntityOperationHandler;
import com.ioxpert.tarazu.syncgateway.HandlerResult;
import com.ioxpert.tarazu.syncgateway.Operation;
import com.ioxpert.tarazu.syncgateway.OperationContext;
import org.springframework.dao.TransientDataAccessResourceException;
import org.springframework.stereotype.Component;

/** Test-only entity type that fails on demand, to prove a failure never leaves a batch half applied. */
@Component
public class FaultInjectionHandler implements EntityOperationHandler {

	/** When true, "chaos_fault" ops with payload.mode=transient throw a retryable infrastructure error. */
	public static final AtomicBoolean TRANSIENT_OUTAGE = new AtomicBoolean();

	@Override
	public String entityType() {
		return "chaos_fault";
	}

	@Override
	public HandlerResult handle(Operation op, OperationContext ctx) {
		String mode = op.payload().text("mode");
		if ("transient".equals(mode) && TRANSIENT_OUTAGE.get()) {
			throw new TransientDataAccessResourceException("simulated database outage");
		}
		if ("bug".equals(mode)) {
			throw new IllegalStateException("simulated handler bug");
		}
		return HandlerResult.applied();
	}
}
