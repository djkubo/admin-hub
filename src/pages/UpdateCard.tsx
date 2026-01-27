import { useEffect, useState } from "react";
import { useSearchParams, useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Loader2, CreditCard, AlertCircle, CheckCircle2, ExternalLink } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

interface PaymentLink {
  id: string;
  token: string;
  stripe_customer_id: string;
  customer_name: string | null;
  customer_email: string | null;
  expires_at: string;
  used_at: string | null;
}

export default function UpdateCard() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const token = searchParams.get("token");
  
  const [status, setStatus] = useState<"loading" | "valid" | "expired" | "invalid" | "redirecting" | "error">("loading");
  const [paymentLink, setPaymentLink] = useState<PaymentLink | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [portalUrl, setPortalUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!token) {
      setStatus("invalid");
      return;
    }

    validateToken(token);
  }, [token]);

  async function validateToken(tokenValue: string) {
    try {
      // Fetch the payment link by token
      const { data, error: fetchError } = await supabase
        .from("payment_update_links")
        .select("*")
        .eq("token", tokenValue)
        .single();

      if (fetchError || !data) {
        console.error("Token not found:", fetchError);
        setStatus("invalid");
        return;
      }

      const link = data as PaymentLink;
      setPaymentLink(link);

      // Check if already used
      if (link.used_at) {
        setStatus("expired");
        setError("Este enlace ya fue utilizado.");
        return;
      }

      // Check if expired
      const expiresAt = new Date(link.expires_at);
      if (expiresAt < new Date()) {
        setStatus("expired");
        setError("Este enlace ha expirado.");
        return;
      }

      setStatus("valid");
    } catch (err) {
      console.error("Error validating token:", err);
      setStatus("error");
      setError("Error al validar el enlace.");
    }
  }

  async function handleOpenPortal() {
    if (!paymentLink) return;

    setStatus("redirecting");

    try {
      // Call the create-portal-session function
      // Since this is a public page, we'll create a special endpoint or use service role
      const response = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/create-portal-session-public`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            token: paymentLink.token,
            stripe_customer_id: paymentLink.stripe_customer_id,
            return_url: window.location.origin + "/update-card/success",
          }),
        }
      );

      const result = await response.json();

      if (!response.ok || !result.url) {
        throw new Error(result.error || "No se pudo crear la sesión del portal");
      }

      // Mark link as used
      await supabase
        .from("payment_update_links")
        .update({ used_at: new Date().toISOString() })
        .eq("id", paymentLink.id);

      // Store URL for manual redirect option
      setPortalUrl(result.url);

      // Redirect to Stripe portal
      window.location.href = result.url;
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : "Error desconocido";
      console.error("Error opening portal:", errorMessage);
      setError(errorMessage);
      setStatus("error");
    }
  }

  // Loading state
  if (status === "loading") {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-4">
        <Card className="w-full max-w-md">
          <CardContent className="pt-6">
            <div className="flex flex-col items-center gap-4">
              <Loader2 className="h-8 w-8 animate-spin text-primary" />
              <p className="text-muted-foreground">Validando enlace...</p>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  // Invalid token
  if (status === "invalid") {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-4">
        <Card className="w-full max-w-md">
          <CardHeader className="text-center">
            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-destructive/10">
              <AlertCircle className="h-6 w-6 text-destructive" />
            </div>
            <CardTitle>Enlace inválido</CardTitle>
            <CardDescription>
              El enlace que utilizaste no es válido. Por favor, contacta a soporte si necesitas ayuda para actualizar tu método de pago.
            </CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }

  // Expired token
  if (status === "expired") {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-4">
        <Card className="w-full max-w-md">
          <CardHeader className="text-center">
            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-yellow-100 dark:bg-yellow-900/20">
              <AlertCircle className="h-6 w-6 text-yellow-600 dark:text-yellow-500" />
            </div>
            <CardTitle>Enlace expirado</CardTitle>
            <CardDescription>
              {error || "Este enlace ya no está disponible."}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Alert>
              <AlertTitle>¿Necesitas ayuda?</AlertTitle>
              <AlertDescription>
                Contacta a nuestro equipo de soporte para obtener un nuevo enlace de actualización.
              </AlertDescription>
            </Alert>
          </CardContent>
        </Card>
      </div>
    );
  }

  // Error state
  if (status === "error") {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-4">
        <Card className="w-full max-w-md">
          <CardHeader className="text-center">
            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-destructive/10">
              <AlertCircle className="h-6 w-6 text-destructive" />
            </div>
            <CardTitle>Error</CardTitle>
            <CardDescription>{error || "Ocurrió un error inesperado."}</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {portalUrl && (
              <Button asChild>
                <a href={portalUrl} target="_blank" rel="noopener noreferrer">
                  <ExternalLink className="mr-2 h-4 w-4" />
                  Abrir portal de pagos manualmente
                </a>
              </Button>
            )}
            <Button variant="outline" onClick={() => window.location.reload()}>
              Intentar de nuevo
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  // Redirecting state
  if (status === "redirecting") {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-4">
        <Card className="w-full max-w-md">
          <CardContent className="pt-6">
            <div className="flex flex-col items-center gap-4">
              <Loader2 className="h-8 w-8 animate-spin text-primary" />
              <p className="text-muted-foreground">Redirigiendo al portal de pagos...</p>
              <p className="text-xs text-muted-foreground">
                Si no eres redirigido automáticamente, haz clic en el botón de abajo.
              </p>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  // Valid token - show update card prompt
  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
            <CreditCard className="h-6 w-6 text-primary" />
          </div>
          <CardTitle>Actualiza tu método de pago</CardTitle>
          <CardDescription>
            {paymentLink?.customer_name 
              ? `Hola ${paymentLink.customer_name}, `
              : ""}
            haz clic en el botón de abajo para actualizar tu tarjeta de crédito o débito de forma segura.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <Button onClick={handleOpenPortal} size="lg" className="w-full">
            <CreditCard className="mr-2 h-4 w-4" />
            Actualizar tarjeta
          </Button>
          
          <div className="text-center text-xs text-muted-foreground">
            <p>Serás redirigido al portal seguro de Stripe</p>
            <p className="mt-1">
              Este enlace expira el{" "}
              {paymentLink?.expires_at
                ? new Date(paymentLink.expires_at).toLocaleDateString("es-MX", {
                    day: "numeric",
                    month: "long",
                    year: "numeric",
                  })
                : ""}
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
