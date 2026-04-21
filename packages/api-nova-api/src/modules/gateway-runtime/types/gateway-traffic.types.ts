export type GatewayTrafficAdmission = {
  release: () => void;
};

export type GatewayBreakerState = 'closed' | 'open' | 'half_open';
