package com.ioxpert.tarazu.syncgateway;

import java.util.List;

import jakarta.validation.Valid;
import jakarta.validation.constraints.NotEmpty;
import jakarta.validation.constraints.Size;

public record UploadRequest(@NotEmpty @Size(max = 500) List<@Valid OperationDto> operations) {
}
