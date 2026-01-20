/**
 * Native SMS Module
 * 
 * Handles sending SMS through the device's native messaging app.
 * On iOS/Mac: Opens the Messages app with pre-filled recipient and message
 * On Android: Can send SMS directly or open the composer
 */

export interface NativeSmsOptions {
  to: string;
  message: string;
}

/**
 * Check if we're running in a native Capacitor environment
 */
export function isNativeApp(): boolean {
  return typeof (window as any).Capacitor !== 'undefined' && 
         (window as any).Capacitor.isNativePlatform();
}

/**
 * Get the current platform
 */
export function getPlatform(): 'ios' | 'android' | 'web' {
  if (!isNativeApp()) return 'web';
  const platform = (window as any).Capacitor?.getPlatform();
  return platform === 'ios' ? 'ios' : platform === 'android' ? 'android' : 'web';
}

/**
 * Clean phone number for SMS URI
 */
function cleanPhoneNumber(phone: string): string {
  return phone.replace(/[^\d+]/g, '');
}

/**
 * Send SMS using the device's native messaging app
 * 
 * iOS/Mac: Opens Messages app with pre-filled content (user taps send)
 * Android: Opens SMS app with pre-filled content
 * Web: Falls back to sms: URI scheme
 */
export async function sendNativeSms({ to, message }: NativeSmsOptions): Promise<{ success: boolean; method: string }> {
  const cleanedPhone = cleanPhoneNumber(to);
  const encodedMessage = encodeURIComponent(message);
  const platform = getPlatform();
  
  try {
    if (platform === 'ios') {
      // iOS uses sms: with &body= parameter
      // This opens the Messages app with the message pre-filled
      const smsUrl = `sms:${cleanedPhone}&body=${encodedMessage}`;
      window.location.href = smsUrl;
      return { success: true, method: 'ios-messages' };
    } 
    else if (platform === 'android') {
      // Android can use sms: URI or intent
      // This opens the default SMS app
      const smsUrl = `sms:${cleanedPhone}?body=${encodedMessage}`;
      window.location.href = smsUrl;
      return { success: true, method: 'android-sms' };
    } 
    else {
      // Web fallback - try sms: URI (works on mobile browsers)
      const smsUrl = `sms:${cleanedPhone}?body=${encodedMessage}`;
      window.open(smsUrl, '_blank');
      return { success: true, method: 'web-sms-uri' };
    }
  } catch (error) {
    console.error('Error opening native SMS:', error);
    return { success: false, method: 'failed' };
  }
}

/**
 * Open WhatsApp with a pre-filled message
 */
export function openWhatsApp(phone: string, message: string): void {
  const cleanedPhone = cleanPhoneNumber(phone).replace(/^\+/, '');
  const encodedMessage = encodeURIComponent(message);
  const waUrl = `https://wa.me/${cleanedPhone}?text=${encodedMessage}`;
  window.open(waUrl, '_blank');
}

/**
 * Check if the device supports native SMS
 * Returns true for native apps and mobile web browsers
 */
export function supportsNativeSms(): boolean {
  const platform = getPlatform();
  if (platform !== 'web') return true;
  
  // Check if mobile browser (can open sms: links)
  const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
  return isMobile;
}
