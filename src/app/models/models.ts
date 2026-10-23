export interface Student {
  id: string;
  name: string;
  grade: string;
  class: string;
  parentName: string;
  parentRelation: string;
  rfidCard: string;
  isVan: boolean;
  /** Id do motorista da van selecionado (VanDriver.id), quando isVan = true. */
  vanDriverId?: string;
  avatarColor: string;
  avatarInitials?: string;
  photo?: string;
  email?: string;
  cpf?: string;
  birthDate?: string;
  guardianPhone?: string;
}

export interface VanDriver {
  id: string;
  name: string;
  plate: string;
  color: string;
  /** Telefone de contato do motorista (opcional). */
  phone?: string;
}

/** Forma de saída do aluno: com o motorista da van ou com um responsável. */
export type ExitMode = 'VAN' | 'RESPONSAVEL';

export interface ExitRecord {
  id: string;
  student: Student;
  exitAt: Date;
  /** Como o aluno saiu da escola. */
  mode: ExitMode;
  /** Nome do motorista ou do responsável que retirou o aluno. */
  releasedTo: string;
}

export interface QueueItem {
  id: string;
  student: Student;
  queuedAt: Date;
}

export interface VanCall {
  driver: VanDriver;
  calledAt: Date;
}