export const BOOT_KEY = "sh-booted";

/** Runs before the page paints, so a returning visitor never sees the boot screen flash. */
export const BOOT_SCRIPT = `try{if(sessionStorage.getItem("${BOOT_KEY}"))document.documentElement.dataset.booted="1"}catch(e){}`;
