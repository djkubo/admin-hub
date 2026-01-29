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

const emailSchema = z.string().email("Email inválido");
const passwordSchema = z.string().min(6, "La contraseña debe tener al menos 6 caracteres");

// Admin email - only this user can access the dashboard
const ADMIN_EMAIL = "djkubo@live.com.mx";

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

    // Check if email is admin
    if (email.toLowerCase().trim() !== ADMIN_EMAIL.toLowerCase()) {
      toast({
        title: "Acceso denegado",
        description: "No tienes permisos para acceder a esta aplicación.",
        variant: "destructive",
      });
      setIsLoading(false);
      return;
    }

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
    <div className="min-h-screen bg-background flex items-center justify-center p-4 relative overflow-hidden">
      {/* VRP Red glow at top */}
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top,_hsl(1_99%_34%_/_0.12)_0%,_transparent_60%)] pointer-events-none" />
      
      {/* Subtle grid pattern */}
      <div className="absolute inset-0 opacity-[0.02]" style={{
        backgroundImage: `url("data:image/svg+xml,%3Csvg width='60' height='60' viewBox='0 0 60 60' xmlns='http://www.w3.org/2000/svg'%3E%3Cg fill='none' fill-rule='evenodd'%3E%3Cg fill='%23ffffff' fill-opacity='1'%3E%3Cpath d='M36 34v-4h-2v4h-4v2h4v4h2v-4h4v-2h-4zm0-30V0h-2v4h-4v2h4v4h2V6h4V4h-4zM6 34v-4H4v4H0v2h4v4h2v-4h4v-2H6zM6 4V0H4v4H0v2h4v4h2V6h4V4H6z'/%3E%3C/g%3E%3C/g%3E%3C/svg%3E")`
      }} />
      
      <Card className="w-full max-w-md bg-card/80 backdrop-blur-sm border-border/50 shadow-2xl relative z-10">
        <CardHeader className="text-center pb-2">
          {/* VRP Logo */}
          <div className="flex justify-center mb-4">
            <img src={vrpLogo} alt="VRP System" className="h-12 object-contain" />
          </div>
          
          <CardTitle className="font-heading text-2xl tracking-wide text-foreground">
            COMMAND CENTER
          </CardTitle>
          <CardDescription className="text-muted-foreground">
            Sistema de administración VRP
          </CardDescription>
        </CardHeader>
        
        <CardContent className="pt-4">
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
                placeholder="admin@vrp.com"
                required
                className="bg-background/50 border-border focus:border-primary focus:ring-primary/30"
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
                className="bg-background/50 border-border focus:border-primary focus:ring-primary/30"
                disabled={isLoading}
              />
            </div>
            
            <Button 
              type="submit" 
              className="w-full h-11 font-heading text-sm tracking-wider uppercase bg-primary hover:bg-primary/90 transition-all duration-200" 
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
          <div className="mt-6 pt-4 border-t border-border/30 text-center">
            <p className="text-[10px] text-muted-foreground/60 font-heading tracking-widest uppercase">
              VRP // Revenue Operations System
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
