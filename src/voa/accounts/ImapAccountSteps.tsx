import {
  CheckCircle2,
  KeyRound,
  Loader2,
  Mail,
  Send,
  Server,
  ShieldCheck,
  XCircle,
} from "lucide-react";
import type { SecurityType } from "@/services/imap/autoDiscovery";
import {
  imapInputClass,
  imapLabelClass,
  imapSelectClass,
  imapStepLabels,
  imapSteps,
  type ConnectionTest,
  type ImapAuthMode,
  type ImapFormState,
  type ImapStep,
} from "./imapForm";

const stepIcons: Record<ImapStep, React.ReactNode> = {
  basic: <Mail className="w-4 h-4" />,
  imap: <Server className="w-4 h-4" />,
  smtp: <Send className="w-4 h-4" />,
  test: <ShieldCheck className="w-4 h-4" />,
};

export function ImapStepIndicator({ current }: { current: ImapStep }) {
  const currentIndex = imapSteps.indexOf(current);
  return (
    <div className="flex items-center justify-center gap-1 mb-6">
      {imapSteps.map((step, i) => {
        const isActive = i === currentIndex;
        const isCompleted = i < currentIndex;
        return (
          <div key={step} className="flex items-center gap-1">
            {i > 0 && <div className={`w-6 h-px ${isCompleted ? "bg-accent" : "bg-border-primary"}`} />}
            <div
              className={`flex items-center gap-1.5 px-2 py-1 rounded-md text-xs font-medium transition-colors ${
                isActive ? "bg-accent/10 text-accent" : isCompleted ? "text-accent" : "text-text-tertiary"
              }`}
            >
              {stepIcons[step]}
              <span className="hidden sm:inline">{imapStepLabels[step]}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Field({
  id,
  label,
  children,
}: {
  id: string;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label htmlFor={id} className={imapLabelClass}>
        {label}
      </label>
      {children}
    </div>
  );
}

export function ImapBasicStep({
  form,
  update,
  onEmailBlur,
  detectedAuthMethods,
  detectedOAuthProviderId,
  oauthConnecting,
  oauthError,
  onOAuthConnect,
}: {
  form: ImapFormState;
  update: <K extends keyof ImapFormState>(key: K, value: ImapFormState[K]) => void;
  onEmailBlur: () => void;
  detectedAuthMethods: ImapAuthMode[];
  detectedOAuthProviderId: string | null;
  oauthConnecting: boolean;
  oauthError: string | null;
  onOAuthConnect: (providerId: string) => void;
}) {
  const isOAuth = form.authMode === "oauth2";
  const hasTokens = !!(form.oauthAccessToken && form.oauthRefreshToken);
  const showOAuth = detectedAuthMethods.includes("oauth2") || isOAuth;
  const providerId = form.oauthProvider ?? detectedOAuthProviderId;
  const providerName = providerId === "microsoft" ? "Microsoft" : providerId === "yahoo" ? "Yahoo" : "Provider";

  return (
    <div className="space-y-4">
      <Field id="imap-email" label="Email Address">
        <input
          id="imap-email"
          type="email"
          value={form.email}
          onChange={(e) => update("email", e.target.value)}
          onBlur={onEmailBlur}
          placeholder="you@example.com"
          className={imapInputClass}
          autoFocus
          disabled={isOAuth && hasTokens}
        />
      </Field>

      {showOAuth && (
        <div className="mb-4">
          <label className={imapLabelClass}>Authentication Method</label>
          <div className="flex gap-2">
            {detectedAuthMethods.includes("password") && (
              <button
                type="button"
                onClick={() => update("authMode", "password")}
                className={`flex-1 flex items-center justify-center gap-2 px-3 py-2 text-sm rounded-lg border transition-colors ${
                  form.authMode === "password"
                    ? "border-accent bg-accent/10 text-accent"
                    : "border-border-primary bg-bg-secondary text-text-secondary hover:bg-bg-hover"
                }`}
              >
                <KeyRound className="w-4 h-4" />
                Password
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                update("authMode", "oauth2");
                if (detectedOAuthProviderId) update("oauthProvider", detectedOAuthProviderId);
              }}
              className={`flex-1 flex items-center justify-center gap-2 px-3 py-2 text-sm rounded-lg border transition-colors ${
                form.authMode === "oauth2"
                  ? "border-accent bg-accent/10 text-accent"
                  : "border-border-primary bg-bg-secondary text-text-secondary hover:bg-bg-hover"
              }`}
            >
              <ShieldCheck className="w-4 h-4" />
              OAuth2
            </button>
          </div>
        </div>
      )}

      {isOAuth ? (
        <div className="space-y-3">
          <Field id="oauth-client-id" label="Client ID">
            <input
              id="oauth-client-id"
              type="text"
              value={form.oauthClientId}
              onChange={(e) => update("oauthClientId", e.target.value)}
              placeholder={`${providerName} app Client ID`}
              className={imapInputClass}
              disabled={hasTokens}
            />
          </Field>
          <Field id="oauth-client-secret" label="Client Secret (optional)">
            <input
              id="oauth-client-secret"
              type="password"
              value={form.oauthClientSecret}
              onChange={(e) => update("oauthClientSecret", e.target.value)}
              placeholder="Leave blank for public clients"
              className={imapInputClass}
              disabled={hasTokens}
            />
          </Field>
          {hasTokens ? (
            <div className="flex items-center gap-2 p-3 rounded-lg bg-success/10 border border-success/20">
              <CheckCircle2 className="w-4 h-4 text-success flex-shrink-0" />
              <div className="text-sm text-success">
                Connected as <span className="font-medium">{form.oauthEmail}</span>
              </div>
            </div>
          ) : (
            <button
              onClick={() => providerId && onOAuthConnect(providerId)}
              disabled={oauthConnecting || !form.oauthClientId.trim()}
              className="w-full flex items-center justify-center gap-2 px-4 py-2.5 text-sm bg-ink text-canvas rounded-lg hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {oauthConnecting ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Connecting...
                </>
              ) : (
                <>
                  <ShieldCheck className="w-4 h-4" />
                  Sign in with {providerName}
                </>
              )}
            </button>
          )}
          {oauthError && (
            <div className="bg-danger/10 border border-danger/20 rounded-lg p-3 text-sm text-danger">{oauthError}</div>
          )}
          <p className="text-xs text-text-tertiary">
            You need to register an app with {providerName} to get a Client ID.{" "}
            {providerId === "microsoft" && (
              <>
                Register at the Azure Portal (App Registrations) with redirect URI{" "}
                <code className="text-accent">http://127.0.0.1:17248</code>.
              </>
            )}
            {providerId === "yahoo" && (
              <>
                Register at the Yahoo Developer Network with redirect URI{" "}
                <code className="text-accent">http://127.0.0.1:17248</code>.
              </>
            )}
          </p>
        </div>
      ) : (
        <>
          <Field id="imap-display-name" label="Display Name (optional)">
            <input
              id="imap-display-name"
              type="text"
              value={form.displayName}
              onChange={(e) => update("displayName", e.target.value)}
              placeholder="Your Name"
              className={imapInputClass}
            />
          </Field>
          <Field id="imap-username" label="Username (optional)">
            <input
              id="imap-username"
              type="text"
              value={form.imapUsername}
              onChange={(e) => update("imapUsername", e.target.value)}
              placeholder="Leave blank to use your email address"
              className={imapInputClass}
            />
            <p className="text-xs text-text-tertiary mt-1">Only needed if your login username differs from your email address.</p>
          </Field>
          <Field id="imap-password" label="Password">
            <input
              id="imap-password"
              type="password"
              value={form.password}
              onChange={(e) => update("password", e.target.value)}
              placeholder="Enter your email password or app password"
              className={imapInputClass}
            />
            <p className="text-xs text-text-tertiary mt-1">If your provider requires it, use an app-specific password.</p>
          </Field>
        </>
      )}

      {isOAuth && hasTokens && (
        <Field id="imap-display-name-oauth" label="Display Name (optional)">
          <input
            id="imap-display-name-oauth"
            type="text"
            value={form.displayName}
            onChange={(e) => update("displayName", e.target.value)}
            placeholder="Your Name"
            className={imapInputClass}
          />
        </Field>
      )}
    </div>
  );
}

export function ImapServerStep({
  kind,
  form,
  update,
  onSecurity,
}: {
  kind: "imap" | "smtp";
  form: ImapFormState;
  update: <K extends keyof ImapFormState>(key: K, value: ImapFormState[K]) => void;
  onSecurity: (security: SecurityType) => void;
}) {
  const isImap = kind === "imap";
  const hostId = isImap ? "imap-host" : "smtp-host";
  const portId = isImap ? "imap-port" : "smtp-port";
  const securityId = isImap ? "imap-security" : "smtp-security";
  return (
    <div className="space-y-4">
      {form.authMode === "oauth2" && (
        <p className="text-xs text-text-tertiary">
          Server settings have been auto-configured for your provider. You can adjust them if needed.
        </p>
      )}
      <Field id={hostId} label={isImap ? "IMAP Server" : "SMTP Server"}>
        <input
          id={hostId}
          type="text"
          value={isImap ? form.imapHost : form.smtpHost}
          onChange={(e) => update(isImap ? "imapHost" : "smtpHost", e.target.value)}
          placeholder={isImap ? "imap.example.com" : "smtp.example.com"}
          className={imapInputClass}
          autoFocus
        />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field id={portId} label="Port">
          <input
            id={portId}
            type="number"
            value={isImap ? form.imapPort : form.smtpPort}
            onChange={(e) => update(isImap ? "imapPort" : "smtpPort", parseInt(e.target.value, 10) || 0)}
            className={imapInputClass}
          />
        </Field>
        <Field id={securityId} label="Security">
          <select
            id={securityId}
            value={isImap ? form.imapSecurity : form.smtpSecurity}
            onChange={(e) => onSecurity(e.target.value as SecurityType)}
            className={imapSelectClass}
          >
            <option value="ssl">SSL/TLS</option>
            <option value="starttls">STARTTLS</option>
            <option value="none">None</option>
          </select>
        </Field>
      </div>
      {isImap ? (
        <>
          <div className="flex items-center gap-2">
            <input
              id="accept-invalid-certs"
              type="checkbox"
              checked={form.acceptInvalidCerts}
              onChange={(e) => update("acceptInvalidCerts", e.target.checked)}
              className="rounded border-border-primary text-accent focus:ring-accent"
            />
            <label htmlFor="accept-invalid-certs" className="text-sm text-text-secondary">
              Accept self-signed certificates
            </label>
          </div>
          <p className="text-xs text-text-tertiary -mt-2 ml-6">Enable for local mail bridges like ProtonMail Bridge</p>
        </>
      ) : (
        form.authMode !== "oauth2" && (
          <>
            <div className="flex items-center gap-2">
              <input
                id="smtp-same-password"
                type="checkbox"
                checked={form.samePassword}
                onChange={(e) => update("samePassword", e.target.checked)}
                className="rounded border-border-primary text-accent focus:ring-accent"
              />
              <label htmlFor="smtp-same-password" className="text-sm text-text-secondary">
                Use same password as IMAP
              </label>
            </div>
            {!form.samePassword && (
              <Field id="smtp-password" label="SMTP Password">
                <input
                  id="smtp-password"
                  type="password"
                  value={form.smtpPassword}
                  onChange={(e) => update("smtpPassword", e.target.value)}
                  placeholder="SMTP password"
                  className={imapInputClass}
                />
              </Field>
            )}
          </>
        )
      )}
    </div>
  );
}

function TestResult({ label, status }: { label: string; status: ConnectionTest }) {
  const icon =
    status.state === "testing" ? (
      <Loader2 className="w-4 h-4 animate-spin text-accent" />
    ) : status.state === "success" ? (
      <CheckCircle2 className="w-4 h-4 text-success" />
    ) : status.state === "error" ? (
      <XCircle className="w-4 h-4 text-danger" />
    ) : (
      <div className="w-4 h-4 rounded-full border-2 border-border-primary" />
    );
  return (
    <div className="flex items-start gap-3 p-3 rounded-lg bg-bg-secondary border border-border-primary">
      <div className="mt-0.5">{icon}</div>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium text-text-primary">{label}</div>
        {status.message && (
          <div
            className={`text-xs mt-0.5 ${
              status.state === "error" ? "text-danger" : status.state === "success" ? "text-success" : "text-text-tertiary"
            }`}
          >
            {status.message}
          </div>
        )}
      </div>
    </div>
  );
}

export function ImapTestStep({
  imap,
  smtp,
  onTest,
  saveError,
}: {
  imap: ConnectionTest;
  smtp: ConnectionTest;
  onTest: () => void;
  saveError: string | null;
}) {
  const testing = imap.state === "testing" || smtp.state === "testing";
  return (
    <div className="space-y-4">
      <div className="text-sm text-text-secondary mb-2">Test your connection settings before adding the account.</div>
      <div className="space-y-3">
        <TestResult label="IMAP Connection" status={imap} />
        <TestResult label="SMTP Connection" status={smtp} />
      </div>
      <button
        onClick={onTest}
        disabled={testing}
        className="w-full px-4 py-2 text-sm bg-bg-secondary border border-border-primary rounded-lg text-text-primary hover:bg-bg-hover transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {testing ? "Testing..." : imap.state === "idle" && smtp.state === "idle" ? "Test Connection" : "Re-test Connection"}
      </button>
      {saveError && <div className="bg-danger/10 border border-danger/20 rounded-lg p-3 text-sm text-danger">{saveError}</div>}
    </div>
  );
}
