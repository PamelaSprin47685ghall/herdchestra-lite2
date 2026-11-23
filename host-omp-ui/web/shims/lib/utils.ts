import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
export function cn(...inputs: ClassValue[]) { return twMerge(clsx(inputs)); }
export const externalLinkClass = "text-primary underline underline-offset-2 hover:no-underline";
export const externalLinkClassNoUnderline = "text-primary hover:underline";
