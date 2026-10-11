// Fixed facts of the story. Documentation IP ranges only (RFC 5737).
export const VPS_IP = "203.0.113.10";
export const VPS_PRIVATE_IP = "10.0.0.5";
export const WRONG_IP = "198.51.100.7";
export const LAPTOP_IP = "192.168.1.23";
export const HOME_PUBLIC_IP = "84.20.11.5";
export const DOMAIN = "crumb.shop";
export const VPS_HOSTNAME = "web-1";
export const ROOT_PASSWORD = "Tq7-mango-river";
export const LAPTOP_USER = "you";
export const DEFAULT_DEPLOY_PASSWORD = "correct-horse-42";
export const HOST_KEY_FP = "SHA256:Xq3vR8mJk2pLw9TnB4cYhE1sFzA6dGuQ0oVi7KxNyM5";

export const PLANS = [
  { name: "XS", cpus: 1, memGb: 1, diskGb: 20, priceEur: 3.5 },
  { name: "S", cpus: 2, memGb: 4, diskGb: 40, priceEur: 4.5 },
  { name: "M", cpus: 4, memGb: 8, diskGb: 80, priceEur: 8.5 },
  { name: "L", cpus: 8, memGb: 16, diskGb: 160, priceEur: 16.9 },
] as const;
