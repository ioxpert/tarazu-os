package com.ioxpert.tarazu;

import org.junit.jupiter.api.Test;
import org.springframework.modulith.core.ApplicationModules;

class ModularityTests {

	@Test
	void moduleBoundariesAreRespected() {
		ApplicationModules.of(TarazuApiApplication.class).verify();
	}
}
