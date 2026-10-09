export interface Student {
  id: string;
  name: string;
  grade: string;
  class: string;
  parentName: string;
  parentRelation: string;
  rfidCard: string;
  isVan: boolean;
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
}

export interface ExitRecord {
  id: string;
  student: Student;
  exitAt: Date;
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