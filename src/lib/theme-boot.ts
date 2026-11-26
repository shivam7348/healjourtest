export const THEME_KEY = "hj-theme";

/** Runs in <head> before the page paints, so a night-mode user never sees a white flash. */
export const THEME_BOOT_SCRIPT = `(function(){try{var c=localStorage.getItem("${THEME_KEY}")||"system";var d=c==="dark"||(c==="system"&&matchMedia("(prefers-color-scheme: dark)").matches);document.documentElement.classList.toggle("dark",d);}catch(e){}})();`;
