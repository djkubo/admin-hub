import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { z } from "zod";

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
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <Card className="w-full max-w-md bg-card border-border">
        <CardHeader className="text-center">
          <CardTitle className="text-2xl font-bold text-foreground">
            Panel de Administración
          </CardTitle>
          <CardDescription>
            Ingresa tus credenciales para continuar
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="tu@email.com"
                required
                className="bg-background border-border"
                disabled={isLoading}
              />
            </div>
            
            <div className="space-y-2">
              <Label htmlFor="password">Contraseña</Label>
              <Input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                required
                minLength={6}
                className="bg-background border-border"
                disabled={isLoading}
              />
            </div>
            
            <Button 
              type="submit" 
              className="w-full" 
              disabled={isLoading}
            >
              {isLoading ? "Cargando..." : "Iniciar Sesión"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
