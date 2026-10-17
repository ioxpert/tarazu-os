/**
 * Receives device upload batches (PowerSync uploadData): validates, stores every operation in the immutable
 * operation log, applies it through the owning module's {@link com.ioxpert.tarazu.syncgateway.EntityOperationHandler},
 * and acknowledges each operation id. Public API: handler SPI (EntityOperationHandler, Operation, Payload,
 * OperationContext, HandlerResult, Hlc).
 */
package com.ioxpert.tarazu.syncgateway;
