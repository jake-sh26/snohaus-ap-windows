import { useState, useEffect } from "react";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card } from "@/components/ui/card";
import { Wordmark } from "@/components/Logo";
import { apiRequest } from "@/lib/queryClient";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/hooks/use-toast";
import { ArrowRight, Mail, Lock, AlertCircle, Eye, EyeOff } from "lucide-react";

const ERROR_MESSAGES: Record<string, string> = {
  google_denied: "Google sign-in was cancelled.",
  invalid_state: "Security check failed. Please try again.",
  no_code: "No authorisation code received from Google.",
  sso_failed: "Google sign-in failed. Please try again.",
  access_denied: "Your Google account doesn't have access. Contact your admin.",
  drive_denied: "Google Drive connection was cancelled.",
  drive_failed: "Failed to connect Google Drive. Please try again.",
};

export default function Login() {
  const [, navigate] = useLocation();
  const { setSession } = useAuth();
  const { toast } = useToast();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Handle SSO callback token in query string and error messages
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const ssoToken = params.get("sso_token");
    const ssoEmail = params.get("email");
    const errorCode = params.get("error");

    if (ssoToken && ssoEmail) {
      // SSO success — store session and navigate
      setSession(ssoToken, decodeURIComponent(ssoEmail));
      toast({ title: "Signed in with Google", description: `Welcome, ${decodeURIComponent(ssoEmail)}` });
      // Clean URL and navigate
      window.history.replaceState({}, "", window.location.pathname);
      navigate("/");
      return;
    }

    if (errorCode) {
      setError(ERROR_MESSAGES[errorCode] || "Sign-in error. Please try again.");
      window.history.replaceState({}, "", window.location.pathname);
    }
  }, []);

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await apiRequest("POST", "/api/auth/login", {
        email: email.trim().toLowerCase(),
        password,
      });
      const json = await res.json();
      setSession(json.token, json.email);
      toast({ title: "Signed in", description: `Welcome back, ${json.email}` });
      navigate("/");
    } catch (err: any) {
      const msg = err.message || "Sign-in failed";
      setError(msg.replace(/^\d+:\s*/, "").replace(/\{.*"message":"([^"]+)".*\}/, "$1"));
    } finally {
      setLoading(false);
    }
  }

  function handleGoogleSignIn() {
    // Navigate to the OAuth flow — server will redirect to Google
    window.location.href = "/api/auth/google/login";
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-4">
      <div className="w-full max-w-md">
        <div className="mb-8 flex justify-center">
          <Wordmark className="text-foreground" />
        </div>
        <Card className="p-8 border-card-border">
          <div className="mb-6">
            <h1 className="text-xl font-semibold tracking-tight">Sign in</h1>
            <p className="text-sm text-muted-foreground mt-1">
              Enter your credentials to continue.
            </p>
          </div>

          {/* Google Sign In — primary action */}
          <Button
            type="button"
            variant="outline"
            className="w-full mb-4"
            onClick={handleGoogleSignIn}
            data-testid="button-google-signin"
          >
            <svg className="size-4 mr-2 shrink-0" viewBox="0 0 48 48" aria-hidden="true">
              <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3c-1.6 4.7-6.1 8-11.3 8-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34.1 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/>
              <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.6 16 19 13 24 13c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34.1 6.1 29.3 4 24 4 16.4 4 9.8 8.4 6.3 14.7z"/>
              <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2c-2 1.5-4.6 2.4-7.2 2.4-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.6 39.6 16.2 44 24 44z"/>
              <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.3-2.3 4.2-4.1 5.6l6.2 5.2C41.5 35.5 44 30.1 44 24c0-1.3-.1-2.4-.4-3.5z"/>
            </svg>
            Sign in with Google
          </Button>

          <div className="relative my-4">
            <div className="absolute inset-0 flex items-center">
              <span className="w-full border-t border-border" />
            </div>
            <div className="relative flex justify-center text-[10px] uppercase tracking-wider">
              <span className="bg-card px-2 text-muted-foreground">or</span>
            </div>
          </div>

          <form onSubmit={handleLogin} className="space-y-4" data-testid="form-login">
            <div className="space-y-1.5">
              <Label htmlFor="email">Email</Label>
              <div className="relative">
                <Mail className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
                <Input
                  id="email"
                  type="email"
                  autoComplete="username"
                  placeholder="you@snohaus.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  autoFocus
                  className="pl-9"
                  data-testid="input-email"
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="password">Password</Label>
              <div className="relative">
                <Lock className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
                <Input
                  id="password"
                  type={showPassword ? "text" : "password"}
                  autoComplete="current-password"
                  placeholder="••••••••"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  className="pl-9 pr-10"
                  data-testid="input-password"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  aria-label={showPassword ? "Hide password" : "Show password"}
                  data-testid="button-toggle-password"
                >
                  {showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                </button>
              </div>
            </div>

            {error && (
              <div className="flex items-start gap-2 p-3 text-xs rounded-md bg-destructive/10 text-destructive border border-destructive/20" data-testid="text-login-error">
                <AlertCircle className="size-4 shrink-0 mt-0.5" />
                <span>{error}</span>
              </div>
            )}

            <Button
              type="submit"
              className="w-full"
              disabled={loading || !email.trim() || !password}
              data-testid="button-login"
            >
              {loading ? "Signing in…" : <>Sign in <ArrowRight className="size-4 ml-1" /></>}
            </Button>
          </form>
        </Card>
        <div className="mt-6 text-center text-xs text-muted-foreground">
          Private dashboard for Sno-Haus accounts payable review.
        </div>
      </div>
    </div>
  );
}
