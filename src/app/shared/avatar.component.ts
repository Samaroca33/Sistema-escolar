import { Component, Input } from '@angular/core';
import { CommonModule } from '@angular/common';

@Component({
  selector: 'app-avatar',
  standalone: true,
  imports: [CommonModule],
  template: `
    <span class="avatar" [class.small]="small" [style.background]="color">
      <img *ngIf="photo" [src]="photo" alt="">
      <ng-container *ngIf="!photo">{{ initials }}</ng-container>
    </span>
  `
})
export class AvatarComponent {
  @Input() name = '';
  @Input() color = '#C8102E';
  @Input() photo?: string;
  @Input() small = false;

  get initials(): string {
    return this.name
      .split(' ')
      .filter(Boolean)
      .slice(0, 2)
      .map(part => part[0])
      .join('')
      .toUpperCase() || 'AL';
  }
}
