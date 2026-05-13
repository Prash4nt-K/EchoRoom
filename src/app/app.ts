import {
  AfterViewInit,
  Component,
  ElementRef,
  OnDestroy,
  ViewChild,
  computed,
  inject,
  signal,
} from '@angular/core';
import { DomSanitizer } from '@angular/platform-browser';
import { FormsModule } from '@angular/forms';

type ChatMessage = {
  id: number;
  author: string;
  text: string;
  isYou?: boolean;
};

type YouTubePlayer = {
  playVideo: () => void;
  pauseVideo: () => void;
  loadVideoById: (videoId: string) => void;
  destroy: () => void;
};

declare global {
  interface Window {
    YT?: {
      Player: new (
        element: HTMLIFrameElement,
        options: {
          events: {
            onReady: () => void;
            onStateChange: (event: { data: number }) => void;
          };
        },
      ) => YouTubePlayer;
      PlayerState: {
        PLAYING: number;
        PAUSED: number;
        ENDED: number;
      };
    };
    onYouTubeIframeAPIReady?: () => void;
  }
}

let youtubeApiPromise: Promise<void> | null = null;

@Component({
  selector: 'app-root',
  imports: [FormsModule],
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App implements AfterViewInit, OnDestroy {
  @ViewChild('player') private player?: ElementRef<HTMLIFrameElement>;
  @ViewChild('chatArea') private chatArea?: ElementRef<HTMLElement>;

  private readonly sanitizer = inject(DomSanitizer);
  private youtubePlayer?: YouTubePlayer;

  protected draft = '';
  protected youtubeLink = '';
  protected readonly isPlaying = signal(false);
  protected readonly isDarkMode = signal(false);
  protected readonly unreadMessageCount = signal(0);
  protected readonly videoId = signal('dQw4w9WgXcQ');
  protected readonly videoUrl = computed(() =>
    this.sanitizer.bypassSecurityTrustResourceUrl(
      `https://www.youtube.com/embed/${this.videoId()}?enablejsapi=1&origin=${window.location.origin}`,
    ),
  );
  protected readonly participants = signal(['Guest 208', 'Guest 771', 'You']);

  protected readonly messages = signal<ChatMessage[]>([
    {
      id: 1,
      author: 'Guest 208',
      text: 'This part is my favorite.',
    },
    {
      id: 2,
      author: 'Guest 771',
      text: 'Same. Watching together makes it better.',
    },
    {
      id: 3,
      author: 'You',
      text: 'Chat on the right, video on the left. Nice and simple.',
      isYou: true,
    },
  ]);

  ngAfterViewInit(): void {
    this.loadYouTubeApi().then(() => this.createYouTubePlayer());
    this.scrollChatToBottom('auto');
  }

  ngOnDestroy(): void {
    this.youtubePlayer?.destroy();
  }

  protected sendMessage(): void {
    const text = this.draft.trim();

    if (!text) {
      return;
    }

    this.addMessage({
      id: Date.now(),
      author: 'You',
      text,
      isYou: true,
    });
    this.draft = '';
  }

  protected onChatScroll(): void {
    if (this.isChatAtBottom()) {
      this.unreadMessageCount.set(0);
    }
  }

  protected scrollToUnreadMessages(): void {
    this.scrollChatToBottom();
  }

  protected loadVideo(): void {
    const videoId = this.getYouTubeVideoId(this.youtubeLink);

    if (!videoId) {
      return;
    }

    if (this.youtubePlayer) {
      this.youtubePlayer.loadVideoById(videoId);
    } else {
      this.videoId.set(videoId);
    }

    this.youtubeLink = '';
  }

  protected togglePlayback(): void {
    if (this.isPlaying()) {
      this.youtubePlayer?.pauseVideo();
      return;
    }

    this.youtubePlayer?.playVideo();
  }

  protected toggleTheme(): void {
    this.isDarkMode.update((isDarkMode) => !isDarkMode);
  }

  private getYouTubeVideoId(link: string): string | null {
    const value = link.trim();

    if (!value) {
      return null;
    }

    try {
      const url = new URL(value);

      if (url.hostname.includes('youtu.be')) {
        return url.pathname.split('/').filter(Boolean)[0] ?? null;
      }

      if (url.searchParams.has('v')) {
        return url.searchParams.get('v');
      }

      const parts = url.pathname.split('/').filter(Boolean);
      const videoPathIndex = parts.findIndex((part) =>
        ['embed', 'shorts', 'live'].includes(part),
      );

      if (videoPathIndex >= 0) {
        return parts[videoPathIndex + 1] ?? null;
      }
    } catch {
      return value.length === 11 ? value : null;
    }

    return null;
  }

  private addMessage(message: ChatMessage): void {
    const shouldScrollToMessage = message.isYou || this.isChatAtBottom();

    this.messages.update((messages) => [...messages, message]);

    if (shouldScrollToMessage) {
      this.scrollChatToBottom();
      return;
    }

    this.unreadMessageCount.update((count) => count + 1);
  }

  private isChatAtBottom(): boolean {
    const element = this.chatArea?.nativeElement;

    if (!element) {
      return true;
    }

    const distanceFromBottom =
      element.scrollHeight - element.scrollTop - element.clientHeight;

    return distanceFromBottom < 24;
  }

  private scrollChatToBottom(behavior: ScrollBehavior = 'smooth'): void {
    window.setTimeout(() => {
      const element = this.chatArea?.nativeElement;

      if (!element) {
        return;
      }

      if (typeof element.scrollTo === 'function') {
        element.scrollTo({
          top: element.scrollHeight,
          behavior,
        });
      } else {
        element.scrollTop = element.scrollHeight;
      }
      this.unreadMessageCount.set(0);
    });
  }

  private createYouTubePlayer(): void {
    const iframe = this.player?.nativeElement;

    if (!iframe || !window.YT) {
      return;
    }

    this.youtubePlayer = new window.YT.Player(iframe, {
      events: {
        onReady: () => undefined,
        onStateChange: (event) => {
          const state = window.YT?.PlayerState;

          if (!state) {
            return;
          }

          if (event.data === state.PLAYING) {
            this.isPlaying.set(true);
          }

          if (event.data === state.PAUSED || event.data === state.ENDED) {
            this.isPlaying.set(false);
          }
        },
      },
    });
  }

  private loadYouTubeApi(): Promise<void> {
    if (window.YT?.Player) {
      return Promise.resolve();
    }

    if (youtubeApiPromise) {
      return youtubeApiPromise;
    }

    youtubeApiPromise = new Promise((resolve) => {
      const previousCallback = window.onYouTubeIframeAPIReady;

      window.onYouTubeIframeAPIReady = () => {
        previousCallback?.();
        resolve();
      };

      const script = document.createElement('script');
      script.src = 'https://www.youtube.com/iframe_api';
      document.body.appendChild(script);
    });

    return youtubeApiPromise;
  }
}
