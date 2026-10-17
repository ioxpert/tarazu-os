package com.ioxpert.tarazu.auth;

import java.util.UUID;

import jakarta.servlet.http.HttpServletRequest;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/** OTP onboarding and login. Everything except {@code /logout} is public (see TenantFilter.PUBLIC_PATHS). */
@RestController
@RequestMapping("/v1/auth")
class AuthController {

	record SignupStartRequest(@NotBlank @Size(max = 200) String ownerName, @NotBlank @Size(max = 200) String businessName,
			@Size(max = 254) String email, @Size(max = 20) String phone) {
	}

	record SignupVerifyRequest(@NotBlank String signupToken, @NotBlank @Pattern(regexp = "email|phone") String channel,
			@NotBlank @Pattern(regexp = "[0-9]{6}") String code) {
	}

	record SignupResendRequest(@NotBlank String signupToken, @NotBlank @Pattern(regexp = "email|phone") String channel) {
	}

	record LoginStartRequest(@NotBlank @Pattern(regexp = "email|phone") String channel, @NotBlank @Size(max = 254) String contact) {
	}

	record LoginVerifyRequest(@NotBlank String challengeToken, @NotBlank @Pattern(regexp = "[0-9]{6}") String code) {
	}

	private final AuthService service;

	AuthController(AuthService service) {
		this.service = service;
	}

	@GetMapping("/otp/config")
	AuthService.OtpConfig config() {
		return service.config();
	}

	@PostMapping("/signup/start")
	ResponseEntity<AuthService.SignupStarted> signupStart(@Valid @RequestBody SignupStartRequest body) {
		return ResponseEntity.status(HttpStatus.ACCEPTED).body(service.startSignup(body.ownerName(), body.businessName(), body.email(), body.phone()));
	}

	@PostMapping("/signup/verify")
	AuthService.SignupProgress signupVerify(@Valid @RequestBody SignupVerifyRequest body) {
		return service.verifySignup(body.signupToken(), body.channel(), body.code());
	}

	@PostMapping("/signup/resend")
	ResponseEntity<Void> signupResend(@Valid @RequestBody SignupResendRequest body) {
		service.resendSignup(body.signupToken(), body.channel());
		return ResponseEntity.accepted().build();
	}

	@PostMapping("/login/start")
	ResponseEntity<AuthService.LoginStarted> loginStart(@Valid @RequestBody LoginStartRequest body) {
		return ResponseEntity.status(HttpStatus.ACCEPTED).body(service.startLogin(body.channel(), body.contact()));
	}

	@PostMapping("/login/verify")
	AuthService.SessionView loginVerify(@Valid @RequestBody LoginVerifyRequest body) {
		return service.verifyLogin(body.challengeToken(), body.code());
	}

	/** Authenticated. Ends the session that made the call. */
	@PostMapping("/logout")
	ResponseEntity<Void> logout(HttpServletRequest request) {
		service.logout(request.getHeader("Authorization"));
		return ResponseEntity.noContent().build();
	}
}
