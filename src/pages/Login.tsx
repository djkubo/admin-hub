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

export default function Login() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [isSignUp, setIsSignUp] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  
  const { signIn, signUp } = useAuth();
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

    try {
      let result;
      
      if (isSignUp) {
        result = await signUp(email, password);
        if (result.error) {
          if (result.error.message.includes("already registered")) {
            toast({
              title: "Usuario ya registrado",
              description: "Este email ya está registrado. Intenta iniciar sesión.",
              variant: "destructive",
            });
          } else {
            throw result.error;
          }
        } else {
          toast({
            title: "Cuenta creada",
            description: "Tu cuenta ha sido creada exitosamente.",
          });
          navigate("/");
        }
      } else {
        result = await signIn(email, password);
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
            {isSignUp ? "Crear Cuenta" : "Iniciar Sesión"}
          </CardTitle>
          <CardDescription>
            {isSignUp 
              ? "Crea una cuenta para acceder al dashboard" 
              : "Ingresa tus credenciales para continuar"
            }
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
              {isLoading 
                ? "Cargando..." 
                : isSignUp ? "Crear Cuenta" : "Iniciar Sesión"
              }
            </Button>
          </form>
          
          <div className="mt-4 text-center">
            <button
              type="button"
              onClick={() => setIsSignUp(!isSignUp)}
              className="text-sm text-muted-foreground hover:text-primary transition-colors"
              disabled={isLoading}
            >
              {isSignUp 
                ? "¿Ya tienes cuenta? Inicia sesión" 
                : "¿No tienes cuenta? Regístrate"
              }
            </button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
