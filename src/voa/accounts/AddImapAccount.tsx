import { useCallback, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { Modal } from "@/voa/ui/Modal";
import { insertImapAccount, insertOAuthImapAccount } from "@/services/db/accounts";
import { useAccountStore } from "@/stores/accountStore";
import { discoverSettings, getDefaultImapPort, getDefaultSmtpPort, type SecurityType } from "@/services/imap/autoDiscovery";
import { getOAuthProvider } from "@/services/oauth/providers";
import { startProviderOAuthFlow } from "@/services/oauth/oauthFlow";
import { ImapBasicStep, ImapServerStep, ImapStepIndicator, ImapTestStep } from "./ImapAccountSteps";
import {
  imapSteps,
  initialImapForm,
  mapImapSecurity,
  type ConnectionTest,
  type ImapAuthMode,
  type ImapFormState,
  type ImapStep,
} from "./imapForm";

interface AddImapAccountProps {
  onClose: () => void;
  onSuccess: () => void;
  onBack: () => void;
}

export function AddImapAccount({ onClose, onSuccess, onBack }: AddImapAccountProps) {
  const [currentStep, setCurrentStep] = useState<ImapStep>("basic");
  const [form, setForm] = useState<ImapFormState>(initialImapForm);
  const [imapTest, setImapTest] = useState<ConnectionTest>({ state: "idle" });
  const [smtpTest, setSmtpTest] = useState<ConnectionTest>({ state: "idle" });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [discoveryApplied, setDiscoveryApplied] = useState(false);
  const [oauthConnecting, setOauthConnecting] = useState(false);
  const [oauthError, setOauthError] = useState<string | null>(null);
  const [detectedAuthMethods, setDetectedAuthMethods] = useState<ImapAuthMode[]>(["password"]);
  const [detectedOAuthProviderId, setDetectedOAuthProviderId] = useState<string | null>(null);
  const addAccount = useAccountStore((s) => s.addAccount);

  const updateForm = useCallback(<K extends keyof ImapFormState>(key: K, value: ImapFormState[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  }, []);

  const handleEmailBlur = useCallback(() => {
    if (discoveryApplied) return;
    const result = discoverSettings(form.email);
    if (result && !form.imapHost && !form.smtpHost) {
      setForm((prev) => ({
        ...prev,
        imapHost: result.settings.imapHost,
        imapPort: result.settings.imapPort,
        imapSecurity: result.settings.imapSecurity,
        smtpHost: result.settings.smtpHost,
        smtpPort: result.settings.smtpPort,
        smtpSecurity: result.settings.smtpSecurity,
        acceptInvalidCerts: result.acceptInvalidCerts ?? false,
        authMode: result.authMethods[0] === "oauth2" ? "oauth2" : prev.authMode,
        oauthProvider: result.oauthProviderId ?? null,
      }));
      setDetectedAuthMethods(result.authMethods);
      setDetectedOAuthProviderId(result.oauthProviderId ?? null);
      setDiscoveryApplied(true);
    }
  }, [form.email, form.imapHost, form.smtpHost, discoveryApplied]);

  const isOAuth = form.authMode === "oauth2";
  const hasOAuthTokens = !!(form.oauthAccessToken && form.oauthRefreshToken);
  const canAdvanceFromBasic = form.email.trim().includes("@") && (isOAuth ? hasOAuthTokens : form.password.trim().length > 0);
  const canAdvanceFromImap = form.imapHost.trim().length > 0 && form.imapPort > 0;
  const canAdvanceFromSmtp = form.smtpHost.trim().length > 0 && form.smtpPort > 0;
  const bothTestsPassed = imapTest.state === "success" && smtpTest.state === "success";

  const goNext = useCallback(() => {
    const idx = imapSteps.indexOf(currentStep);
    if (idx < imapSteps.length - 1) setCurrentStep(imapSteps[idx + 1]!);
  }, [currentStep]);

  const goPrev = useCallback(() => {
    const idx = imapSteps.indexOf(currentStep);
    if (idx > 0) setCurrentStep(imapSteps[idx - 1]!);
    else onBack();
  }, [currentStep, onBack]);

  const canGoNext = (): boolean => {
    switch (currentStep) {
      case "basic":
        return canAdvanceFromBasic;
      case "imap":
        return canAdvanceFromImap;
      case "smtp":
        return canAdvanceFromSmtp;
      default:
        return false;
    }
  };

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && currentStep !== "test" && canGoNext()) {
        e.preventDefault();
        goNext();
      }
    },
    [currentStep, goNext, canGoNext],
  );

  const handleOAuthConnect = async (providerId: string) => {
    const provider = getOAuthProvider(providerId);
    if (!provider) {
      setOauthError(`Unknown provider: ${providerId}`);
      return;
    }
    if (!form.oauthClientId.trim()) {
      setOauthError("Please enter a Client ID first.");
      return;
    }
    setOauthConnecting(true);
    setOauthError(null);
    try {
      const { tokens, userInfo } = await startProviderOAuthFlow(provider, form.oauthClientId.trim(), form.oauthClientSecret.trim() || undefined);
      setForm((prev) => ({
        ...prev,
        oauthAccessToken: tokens.access_token,
        oauthRefreshToken: tokens.refresh_token ?? null,
        oauthExpiresAt: Math.floor(Date.now() / 1000) + tokens.expires_in,
        oauthEmail: userInfo.email,
        email: userInfo.email || prev.email,
        displayName: userInfo.name || prev.displayName,
        oauthProvider: providerId,
      }));
    } catch (err) {
      setOauthError(err instanceof Error ? err.message : String(err));
    } finally {
      setOauthConnecting(false);
    }
  };

  const username = () => form.imapUsername || (isOAuth ? (form.oauthEmail ?? form.email) : form.email);

  const testImapConnection = async () => {
    setImapTest({ state: "testing" });
    try {
      const result = await invoke<string>("imap_test_connection", {
        config: {
          host: form.imapHost,
          port: form.imapPort,
          security: mapImapSecurity(form.imapSecurity),
          username: username(),
          password: isOAuth ? (form.oauthAccessToken ?? "") : form.password,
          auth_method: isOAuth ? "oauth2" : "password",
          accept_invalid_certs: form.acceptInvalidCerts,
        },
      });
      setImapTest({ state: "success", message: result });
    } catch (err) {
      setImapTest({ state: "error", message: err instanceof Error ? err.message : String(err) });
    }
  };

  const testSmtpConnection = async () => {
    setSmtpTest({ state: "testing" });
    try {
      const result = await invoke<{ success: boolean; message: string }>("smtp_test_connection", {
        config: {
          host: form.smtpHost,
          port: form.smtpPort,
          security: mapImapSecurity(form.smtpSecurity),
          username: username(),
          password: isOAuth ? (form.oauthAccessToken ?? "") : form.samePassword ? form.password : form.smtpPassword,
          auth_method: isOAuth ? "oauth2" : "password",
          accept_invalid_certs: form.acceptInvalidCerts,
        },
      });
      setSmtpTest({ state: result.success ? "success" : "error", message: result.message });
    } catch (err) {
      setSmtpTest({ state: "error", message: err instanceof Error ? err.message : String(err) });
    }
  };

  const handleSave = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      const accountId = crypto.randomUUID();
      const email = (isOAuth ? form.oauthEmail : null) ?? form.email.trim();
      const imapUsername = form.imapUsername.trim() || null;
      if (isOAuth) {
        await insertOAuthImapAccount({
          id: accountId,
          email,
          displayName: form.displayName.trim() || null,
          avatarUrl: null,
          imapHost: form.imapHost.trim(),
          imapPort: form.imapPort,
          imapSecurity: form.imapSecurity,
          smtpHost: form.smtpHost.trim(),
          smtpPort: form.smtpPort,
          smtpSecurity: form.smtpSecurity,
          accessToken: form.oauthAccessToken!,
          refreshToken: form.oauthRefreshToken!,
          tokenExpiresAt: form.oauthExpiresAt!,
          oauthProvider: form.oauthProvider!,
          oauthClientId: form.oauthClientId.trim(),
          oauthClientSecret: form.oauthClientSecret.trim() || null,
          imapUsername,
          acceptInvalidCerts: form.acceptInvalidCerts,
        });
      } else {
        await insertImapAccount({
          id: accountId,
          email,
          displayName: form.displayName.trim() || null,
          avatarUrl: null,
          imapHost: form.imapHost.trim(),
          imapPort: form.imapPort,
          imapSecurity: form.imapSecurity,
          smtpHost: form.smtpHost.trim(),
          smtpPort: form.smtpPort,
          smtpSecurity: form.smtpSecurity,
          authMethod: "password",
          password: form.samePassword ? form.password : form.password,
          imapUsername,
          acceptInvalidCerts: form.acceptInvalidCerts,
        });
      }
      addAccount({ id: accountId, email, displayName: form.displayName.trim() || null, avatarUrl: null, isActive: true });
      onSuccess();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
      setSaving(false);
    }
  };

  const onSecurity = (security: SecurityType) => {
    if (currentStep === "imap") setForm((prev) => ({ ...prev, imapSecurity: security, imapPort: getDefaultImapPort(security) }));
    else setForm((prev) => ({ ...prev, smtpSecurity: security, smtpPort: getDefaultSmtpPort(security) }));
  };

  return (
    <Modal isOpen={true} onClose={onClose} title="Add IMAP/SMTP Account" width="w-full max-w-lg">
      <div className="p-4" onKeyDown={handleKeyDown}>
        <ImapStepIndicator current={currentStep} />
        {currentStep === "basic" && (
          <ImapBasicStep
            form={form}
            update={updateForm}
            onEmailBlur={handleEmailBlur}
            detectedAuthMethods={detectedAuthMethods}
            detectedOAuthProviderId={detectedOAuthProviderId}
            oauthConnecting={oauthConnecting}
            oauthError={oauthError}
            onOAuthConnect={handleOAuthConnect}
          />
        )}
        {(currentStep === "imap" || currentStep === "smtp") && (
          <ImapServerStep kind={currentStep} form={form} update={updateForm} onSecurity={onSecurity} />
        )}
        {currentStep === "test" && (
          <ImapTestStep
            imap={imapTest}
            smtp={smtpTest}
            onTest={() => void Promise.all([testImapConnection(), testSmtpConnection()])}
            saveError={saveError}
          />
        )}
        <div className="flex items-center justify-between mt-6">
          <button onClick={goPrev} className="flex items-center gap-1 px-3 py-2 text-sm text-text-secondary hover:text-text-primary transition-colors">
            <ArrowLeft className="w-3.5 h-3.5" />
            Back
          </button>
          <div className="flex gap-2">
            <button onClick={onClose} className="px-4 py-2 text-sm text-text-secondary hover:text-text-primary transition-colors">
              Cancel
            </button>
            {currentStep === "test" ? (
              <button
                onClick={handleSave}
                disabled={!bothTestsPassed || saving}
                className="px-4 py-2 text-sm bg-ink text-canvas rounded-lg hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {saving ? "Adding..." : "Add Account"}
              </button>
            ) : (
              <button
                onClick={goNext}
                disabled={!canGoNext()}
                className="flex items-center gap-1 px-4 py-2 text-sm bg-ink text-canvas rounded-lg hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Next
                <ArrowRight className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        </div>
      </div>
    </Modal>
  );
}
