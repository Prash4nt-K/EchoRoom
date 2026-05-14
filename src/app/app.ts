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
import { io, Socket } from 'socket.io-client';

type ChatMessage = {
  id: number;
  author: string;
  text: string;
  isYou?: boolean;
};

type RoomResponse = {
  message?: string;
  roomId?: string;
  error?: string;
};

type RoomUsersEvent = {
  users?: string[];
  count?: number;
};

type ChatMessageEvent = {
  sender?: string;
  author?: string;
  content?: string;
  text?: string;
};

type RoomSession = {
  name: string;
  roomId: string;
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
const API_BASE = 'http://localhost:8080';
const SOCKET_BASE = 'http://localhost:9092';
const ROOM_SESSION_KEY = 'echo-room-session';

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
  private socket?: Socket;

  protected draft = '';
  protected userName = '';
  protected roomKey = '';
  protected readonly authError = signal('');
  protected readonly currentUserName = signal('');
  protected readonly isRoomRequestPending = signal(false);
  protected signedIn = signal(false);
  protected authMode = signal<'join' | 'create'>('join');
  protected currentRoomId = signal('');
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
  protected readonly participants = signal<string[]>([]);
  protected readonly messages = signal<ChatMessage[]>([]);

  ngAfterViewInit(): void {
    this.loadYouTubeApi().then(() => this.createYouTubePlayer());
    this.scrollChatToBottom('auto');
    this.restoreRoomSession();
  }

  ngOnDestroy(): void {
    this.youtubePlayer?.destroy();
    this.socket?.disconnect();
  }

  protected setAuthMode(mode: 'join' | 'create'): void {
    this.authMode.set(mode);
    this.authError.set('');
    if (mode === 'create') {
      this.roomKey = '';
    }
  }

  protected async joinRoom(): Promise<void> {
    const name = this.userName.trim();
    const roomId = this.roomKey.trim();

    if (!name || !roomId) {
      this.authError.set('Enter your name and a room key.');
      return;
    }

    await this.withRoomRequest(async () => {
      const result = await this.postRoom('/api/rooms/join', { name, roomId });

      if (result.message !== 'Room available' && !result.roomId) {
        throw new Error(result.error || result.message || 'Room is not available.');
      }

      this.enterRoom(name, result.roomId || roomId);
    });
  }

  protected async createRoom(): Promise<void> {
    const name = this.userName.trim();

    if (!name) {
      this.authError.set('Enter your name to create a room.');
      return;
    }

    await this.withRoomRequest(async () => {
      const result = await this.postRoom('/api/rooms/create', { name });

      if (!result.roomId) {
        throw new Error(result.error || result.message || 'Could not create a room.');
      }

      this.roomKey = result.roomId;
      this.enterRoom(name, result.roomId);
    });
  }

  private enterRoom(name: string, roomId: string): void {
    this.currentUserName.set(name);
    this.currentRoomId.set(roomId);
    this.saveRoomSession(name, roomId);
    this.participants.set([name]);
    this.messages.set([]);
    this.unreadMessageCount.set(0);
    this.connectSocket();
    this.socket?.emit('joinRoom', { roomId, name });
    this.signedIn.set(true);
  }

  protected sendMessage(): void {
    const text = this.draft.trim();

    if (!text) {
      return;
    }

    this.socket?.emit('sendMessage', {
      roomId: this.currentRoomId(),
      sender: this.currentUserName(),
      content: text,
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

  private async withRoomRequest(request: () => Promise<void>): Promise<void> {
    this.authError.set('');
    this.isRoomRequestPending.set(true);

    try {
      await request();
    } catch (error) {
      this.authError.set(
        error instanceof Error
          ? error.message
          : 'Something went wrong while entering the room.',
      );
    } finally {
      this.isRoomRequestPending.set(false);
    }
  }

  private async postRoom(path: string, body: Record<string, string>): Promise<RoomResponse> {
    const response = await fetch(`${API_BASE}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    const result = (await response.json()) as RoomResponse;

    if (!response.ok) {
      throw new Error(result.error || result.message || 'The room server rejected the request.');
    }

    return result;
  }

  private connectSocket(): void {
    if (this.socket) {
      this.socket.disconnect();
    }

    this.socket = io(SOCKET_BASE);

    this.socket.on('chatMessage', (message: ChatMessageEvent) => {
      const author = message.sender || message.author || 'Someone';
      const text = message.content || message.text || '';

      if (!text) {
        return;
      }

      this.addMessage({
        id: Date.now() + Math.random(),
        author,
        text,
        isYou: author === this.currentUserName(),
      });
    });

    this.socket.on('roomUsers', (data: RoomUsersEvent) => {
      this.participants.set(data.users?.length ? data.users : [this.currentUserName()]);
    });

    this.socket.on('roomError', (error: { message?: string }) => {
      this.authError.set(error.message || 'The room socket reported an error.');
    });

    this.socket.on('connect_error', () => {
      this.authError.set('Could not connect to the live room server.');
    });
  }

  private restoreRoomSession(): void {
    const session = this.getRoomSession();

    if (!session) {
      return;
    }

    this.userName = session.name;
    this.roomKey = session.roomId;
    this.joinRoom();
  }

  private saveRoomSession(name: string, roomId: string): void {
    sessionStorage.setItem(
      ROOM_SESSION_KEY,
      JSON.stringify({
        name,
        roomId,
      } satisfies RoomSession),
    );
  }

  private getRoomSession(): RoomSession | null {
    const value = sessionStorage.getItem(ROOM_SESSION_KEY);

    if (!value) {
      return null;
    }

    try {
      const session = JSON.parse(value) as Partial<RoomSession>;

      if (!session.name || !session.roomId) {
        return null;
      }

      return {
        name: session.name,
        roomId: session.roomId,
      };
    } catch {
      sessionStorage.removeItem(ROOM_SESSION_KEY);
      return null;
    }
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
