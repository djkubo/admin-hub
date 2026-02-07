import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { z } from "zod";
import vrpLogo from "@/assets/vrp-logo.png";
import { Lock } from "lucide-react";
import { buildInfo } from "@/lib/buildInfo";

const emailSchema = z.string().email("Email inválido");
const passwordSchema = z.string().min(6, "La contraseña debe tener al menos 6 caracteres");

// Security: Admin validation is handled server-side via app_admins table and is_admin() function
// Client-side checks were removed to prevent credential exposure

export default function Login() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  
  const { signIn } = useAuth();
  const navigate = useNavigate();
  const { toast } = useToast();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);

    // Validate inputs
    try {
      emailSchema.parse(email);
      passwordSchema.parse(password);
    } catch (validationError) {
      if (validationError instanceof z.ZodError) {
        toast({
          title: "Error de validación",
          description: validationError.errors[0].message,
          variant: "destructive",
        });
        setIsLoading(false);
        return;
      }
    }

    // Authentication is handled server-side by Supabase Auth
    // Authorization is enforced by RLS policies using is_admin() function
    try {
      const result = await signIn(email, password);
      if (result.error) {
        if (result.error.message.includes("Invalid login")) {
          toast({
            title: "Credenciales inválidas",
            description: "Email o contraseña incorrectos.",
            variant: "destructive",
          });
        } else {
          throw result.error;
        }
      } else {
        toast({
          title: "Bienvenido",
          description: "Has iniciado sesión correctamente.",
        });
        navigate("/");
      }
    } catch (error) {
      toast({
        title: "Error",
        description: error instanceof Error ? error.message : "Ocurrió un error inesperado",
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <Card className="w-full max-w-md bg-card border-border shadow-elevated">
        <CardHeader className="text-center pb-2">
          {/* VRP Logo */}
          <div className="flex justify-center mb-6">
            <img src={vrpLogo} alt="VRP System" className="h-12 object-contain" />
          </div>
          
          <CardTitle className="font-display text-2xl tracking-wide text-foreground">
            CENTRO DE COMANDO
          </CardTitle>
          <CardDescription className="text-muted-foreground">
            Sistema de administración VRP
          </CardDescription>
        </CardHeader>
        
        <CardContent className="pt-6">
          <form onSubmit={handleSubmit} className="space-y-5">
            <div className="space-y-2">
              <Label htmlFor="email" className="text-sm font-medium text-foreground">
                Email
              </Label>
              <Input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="tu@email.com"
                required
                disabled={isLoading}
              />
            </div>
            
            <div className="space-y-2">
              <Label htmlFor="password" className="text-sm font-medium text-foreground">
                Contraseña
              </Label>
              <Input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                required
                minLength={6}
                disabled={isLoading}
              />
            </div>
            
            <Button 
              type="submit" 
              className="w-full h-11 font-medium" 
              disabled={isLoading}
            >
              {isLoading ? (
                <span className="flex items-center gap-2">
                  <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                  </svg>
                  Accediendo...
                </span>
              ) : (
                <span className="flex items-center gap-2">
                  <Lock className="h-4 w-4" />
                  Iniciar Sesión
                </span>
              )}
            </Button>
          </form>
          
          {/* Footer branding */}
          <div className="mt-8 pt-6 border-t border-border text-center">
            <p className="text-xs text-muted-foreground">
              VRP Operaciones de Ingresos
            </p>
            <p className="mt-1 text-[10px] text-muted-foreground font-mono">
              Build {buildInfo.gitSha} · {new Date(buildInfo.buildTime).toLocaleString()}
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
