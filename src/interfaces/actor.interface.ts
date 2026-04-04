export interface AuditActor {
  id: string | null;
  type: 'user' | 'system' | 'api_key';
  ip?: string;
}

export type ActorExtractor = (req: any) => AuditActor;
