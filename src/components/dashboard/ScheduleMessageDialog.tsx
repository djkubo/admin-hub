import { useState } from "react";
import { format, addHours, addDays, setHours, setMinutes } from "date-fns";
import { es } from "date-fns/locale";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Clock, CalendarDays, Zap } from "lucide-react";
import { cn } from "@/lib/utils";

interface ScheduleMessageDialogProps {
  onSchedule: (scheduledAt: Date) => void;
  disabled?: boolean;
  children?: React.ReactNode;
}

// Quick schedule options
const QUICK_OPTIONS = [
  { label: "En 1 hora", getValue: () => addHours(new Date(), 1) },
  { label: "En 3 horas", getValue: () => addHours(new Date(), 3) },
  { label: "Mañana 9AM", getValue: () => setMinutes(setHours(addDays(new Date(), 1), 9), 0) },
  { label: "Mañana 2PM", getValue: () => setMinutes(setHours(addDays(new Date(), 1), 14), 0) },
];

// Generate time options (every 30 minutes)
const generateTimeOptions = () => {
  const options: { value: string; label: string }[] = [];
  for (let h = 0; h < 24; h++) {
    for (const m of [0, 30]) {
      const hour = h.toString().padStart(2, "0");
      const min = m.toString().padStart(2, "0");
      options.push({
        value: `${hour}:${min}`,
        label: `${hour}:${min}`,
      });
    }
  }
  return options;
};

const TIME_OPTIONS = generateTimeOptions();

export function ScheduleMessageDialog({ onSchedule, disabled, children }: ScheduleMessageDialogProps) {
  const [open, setOpen] = useState(false);
  const [selectedDate, setSelectedDate] = useState<Date | undefined>(undefined);
  const [selectedTime, setSelectedTime] = useState<string>("09:00");

  const handleQuickSchedule = (getDate: () => Date) => {
    onSchedule(getDate());
    setOpen(false);
    resetState();
  };

  const handleCustomSchedule = () => {
    if (!selectedDate) return;
    
    const [hours, minutes] = selectedTime.split(":").map(Number);
    const scheduledDate = setMinutes(setHours(selectedDate, hours), minutes);
    
    if (scheduledDate <= new Date()) {
      return; // Don't allow past dates
    }
    
    onSchedule(scheduledDate);
    setOpen(false);
    resetState();
  };

  const resetState = () => {
    setSelectedDate(undefined);
    setSelectedTime("09:00");
  };

  const isValidSchedule = selectedDate && new Date(
    setMinutes(setHours(selectedDate, parseInt(selectedTime.split(":")[0])), parseInt(selectedTime.split(":")[1]))
  ) > new Date();

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {children || (
          <Button
            variant="ghost"
            size="icon"
            disabled={disabled}
            className="h-9 w-9 text-muted-foreground hover:text-foreground"
          >
            <Clock className="h-5 w-5" />
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="sm:max-w-[425px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Clock className="h-5 w-5 text-primary" />
            Programar Mensaje
          </DialogTitle>
          <DialogDescription>
            Elige cuándo quieres que se envíe el mensaje
          </DialogDescription>
        </DialogHeader>

        {/* Quick Options */}
        <div className="space-y-3">
          <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
            <Zap className="h-4 w-4" />
            Opciones rápidas
          </div>
          <div className="grid grid-cols-2 gap-2">
            {QUICK_OPTIONS.map((option) => (
              <Button
                key={option.label}
                variant="outline"
                size="sm"
                onClick={() => handleQuickSchedule(option.getValue)}
                className="justify-start"
              >
                {option.label}
              </Button>
            ))}
          </div>
        </div>

        {/* Divider */}
        <div className="relative">
          <div className="absolute inset-0 flex items-center">
            <span className="w-full border-t" />
          </div>
          <div className="relative flex justify-center text-xs uppercase">
            <span className="bg-background px-2 text-muted-foreground">
              o elige fecha y hora
            </span>
          </div>
        </div>

        {/* Custom Date/Time */}
        <div className="space-y-4">
          <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
            <CalendarDays className="h-4 w-4" />
            Fecha personalizada
          </div>
          
          <Calendar
            mode="single"
            selected={selectedDate}
            onSelect={setSelectedDate}
            disabled={(date) => date < new Date(new Date().setHours(0, 0, 0, 0))}
            locale={es}
            className="rounded-md border mx-auto"
          />

          <div className="flex items-center gap-3">
            <span className="text-sm text-muted-foreground">Hora:</span>
            <Select value={selectedTime} onValueChange={setSelectedTime}>
              <SelectTrigger className="w-[120px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="max-h-[200px]">
                {TIME_OPTIONS.map((time) => (
                  <SelectItem key={time.value} value={time.value}>
                    {time.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            
            {selectedDate && (
              <span className="text-sm text-muted-foreground">
                {format(selectedDate, "d 'de' MMMM", { locale: es })}
              </span>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancelar
          </Button>
          <Button 
            onClick={handleCustomSchedule}
            disabled={!isValidSchedule}
          >
            Programar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
