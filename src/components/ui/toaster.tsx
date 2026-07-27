import {
  Toast,
  ToastClose,
  ToastDescription,
  ToastTitle,
  ToastViewport,
} from "@/components/ui/toast";
import { useToast } from "@/hooks/use-toast";

/**
 * Puente entre el store de `use-toast` y los primitivos de Radix.
 *
 * Sin este componente nadie se suscribe a `useToast()`, así que cada
 * `toast({...})` del pipeline (errores de guardado, límites de la edge
 * function, avisos de señal) se descartaba en silencio.
 */
export function Toaster() {
  const { toasts, dismiss } = useToast();

  return (
    <>
      {toasts.map(({ id, title, description, action, ...props }) => (
        <Toast
          key={id}
          onOpenChange={(open) => {
            if (!open) dismiss(id);
          }}
          {...props}
        >
          <div className="grid gap-1">
            {title && <ToastTitle>{title}</ToastTitle>}
            {description && <ToastDescription>{description}</ToastDescription>}
          </div>
          {action}
          <ToastClose />
        </Toast>
      ))}
      <ToastViewport />
    </>
  );
}
