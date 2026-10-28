import * as Primitive from "@radix-ui/react-dialog";
import { forwardRef, type ComponentPropsWithoutRef, type ElementRef, type HTMLAttributes } from "react";

export const Dialog = Primitive.Root;
export const DialogTitle = Primitive.Title;
export const DialogDescription = Primitive.Description;
export const DialogHeader = ({ className = "", ...props }: HTMLAttributes<HTMLDivElement>) => <div className={`dialog-header ${className}`} {...props} />;
export const DialogContent = forwardRef<ElementRef<typeof Primitive.Content>, ComponentPropsWithoutRef<typeof Primitive.Content>>(function DialogContent({ children, className = "", ...props }, ref) {
  return <Primitive.Portal><Primitive.Overlay className="dialog-overlay" /><Primitive.Content ref={ref} className={`dialog-content ${className}`} {...props}>{children}<Primitive.Close className="dialog-close" aria-label="Close dialog">×</Primitive.Close></Primitive.Content></Primitive.Portal>;
});
