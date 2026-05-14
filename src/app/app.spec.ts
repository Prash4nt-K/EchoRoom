import { TestBed } from '@angular/core/testing';
import { App } from './app';

describe('App', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [App],
    }).compileComponents();
  });

  it('should create the app', () => {
    const fixture = TestBed.createComponent(App);
    const app = fixture.componentInstance;
    expect(app).toBeTruthy();
  });

  it('should render the watch room', async () => {
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    const compiled = fixture.nativeElement as HTMLElement;
    expect(compiled.querySelector('.brand')?.textContent).toContain('EchoRoom');
    expect(compiled.querySelector('iframe')?.getAttribute('title')).toContain('Shared YouTube video');
    expect(compiled.querySelector('.chat-area')?.getAttribute('aria-label')).toContain('Messages');
    expect(compiled.querySelector('#messageInput')?.getAttribute('placeholder')).toContain(
      'Type a message',
    );
  });
});
