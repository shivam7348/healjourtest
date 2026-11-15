import { useState, type InputHTMLAttributes } from "react";
import { Eye, EyeOff } from "lucide-react";

/** Password field with a show/hide button. Use it for every password or secret input. */
export function PasswordInput(props: Omit<InputHTMLAttributes<HTMLInputElement>, "type">) {
  const [shown, setShown] = useState(false);
  return <span className="password-input">
    <input {...props} type={shown ? "text" : "password"} spellCheck={false} autoCapitalize="off" />
    <button
      type="button"
      className="password-toggle"
      aria-label={shown ? "Hide password" : "Show password"}
      aria-pressed={shown}
      title={shown ? "Hide" : "Show"}
      onClick={e => { e.preventDefault(); setShown(s => !s); }}
    >
      {shown ? <EyeOff size={16} /> : <Eye size={16} />}
    </button>
  </span>;
}

/** Small live hint under a "confirm password" field. */
export function MatchHint({ value, confirm }: { value: string; confirm: string }) {
  if (!confirm) return null;
  const same = value === confirm;
  return <small className={same ? "match-ok" : "match-bad"}>{same ? "Passwords match." : "Passwords do not match yet."}</small>;
}
