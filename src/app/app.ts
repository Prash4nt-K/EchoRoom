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
import { environment } from '../environments/environment';

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

type VideoSyncEvent = {
  type?: 'change' | 'play' | 'pause' | 'seek' | 'state';
  videoId?: string;
  currentTime?: number;
  isPlaying?: boolean;
  updatedAt?: number;
  sender?: string;
  senderClientId?: string;
};

type ControlStateEvent = {
  controller?: string;
  controllerClientId?: string;
};

type SocketErrorResponse = {
  message?: string;
};

type RealtimeMessage<T = unknown> = {
  event: string;
  data: T;
};

type RoomSession = {
  name: string;
  roomId: string;
};

type YouTubePlayer = {
  playVideo: () => void;
  pauseVideo: () => void;
  seekTo: (seconds: number, allowSeekAhead: boolean) => void;
  getCurrentTime: () => number;
  loadVideoById: (video: string | { videoId: string; startSeconds?: number }) => void;
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
const ROOM_SESSION_KEY = 'echo-room-session';
const SENDER_CLIENT_ID_KEY = 'echo-room-sender-client-id';

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
  private realtimeSocket?: WebSocket;
  private reconnectTimeoutId?: number;
  private isRealtimeDisconnectExpected = false;
  private isApplyingRemoteVideoState = false;
  private isPlayerReady = false;
  private pendingVideoState?: VideoSyncEvent;
  private playerSyncIntervalId?: number;
  private pendingAutoplayTimeoutId?: number;
  private pendingAutoplayVideoId = '';
  private lastObservedPlayerTime = 0;
  private lastObservedAt = 0;
  private readonly senderClientId = this.createSenderClientId();

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
  protected readonly isAmbientMode = signal(false);
  protected readonly isMobileMenuOpen = signal(false);
  protected readonly isRoomIdCopied = signal(false);
  protected readonly unreadMessageCount = signal(0);
  protected readonly controllerName = signal('');
  protected readonly hasVideoControl = computed(
    () => this.controllerName() === this.currentUserName(),
  );
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
    if (this.playerSyncIntervalId) {
      window.clearInterval(this.playerSyncIntervalId);
    }
    if (this.pendingAutoplayTimeoutId) {
      window.clearTimeout(this.pendingAutoplayTimeoutId);
    }
    this.youtubePlayer?.destroy();
    this.disconnectRealtime();
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
      const result = await this.postRoom('/rooms/join', {
        name,
        roomId,
        senderClientId: this.senderClientId,
      });

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
      const result = await this.postRoom('/rooms/create', { name });

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
    this.controllerName.set('');
    this.unreadMessageCount.set(0);
    this.signedIn.set(true);
    this.connectRealtime();
  }

  protected sendMessage(): void {
    const text = this.draft.trim();

    if (!text) {
      return;
    }

    if (this.tryLoadVideoFromChat(text)) {
      this.draft = '';
      return;
    }

    this.sendRealtime('sendMessage', {
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
    if (this.loadVideoFromLink(this.youtubeLink, true)) {
      this.youtubeLink = '';
    }
  }

  protected togglePlayback(): void {
    if (!this.hasVideoControl()) {
      return;
    }

    if (this.isPlaying()) {
      this.clearPendingAutoplay();
      this.isPlaying.set(false);
      this.youtubePlayer?.pauseVideo();
      return;
    }

    this.isPlaying.set(true);
    this.youtubePlayer?.playVideo();
  }

  protected toggleTheme(): void {
    this.isDarkMode.update((isDarkMode) => !isDarkMode);
  }

  protected toggleMobileMenu(): void {
    this.isMobileMenuOpen.update((isOpen) => !isOpen);
  }

  protected toggleAmbientMode(): void {
    this.isAmbientMode.update((isAmbientMode) => !isAmbientMode);
  }

  protected async copyRoomId(): Promise<void> {
    const roomId = this.currentRoomId();

    if (!roomId) {
      return;
    }

    try {
      await navigator.clipboard.writeText(roomId);
      this.isRoomIdCopied.set(true);
      window.setTimeout(() => this.isRoomIdCopied.set(false), 1600);
    } catch {
      this.authError.set('Could not copy room id.');
    }
  }

  protected takeVideoControl(): void {
    if (!this.currentRoomId()) {
      return;
    }

    this.sendRealtime('requestControl', {
      roomId: this.currentRoomId(),
      name: this.currentUserName(),
      senderClientId: this.senderClientId,
    });
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
    const response = await fetch(`${environment.apiBaseUrl}${path}`, {
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

  private connectRealtime(): void {
    this.closeRealtimeSocket();
    this.isRealtimeDisconnectExpected = false;

    const socket = new WebSocket(environment.socketBaseUrl);
    this.realtimeSocket = socket;

    socket.onopen = () => {
      this.sendRealtime('joinRoom', {
        roomId: this.currentRoomId(),
        name: this.currentUserName(),
        senderClientId: this.senderClientId,
      });
    };

    socket.onmessage = (message) => {
      this.handleRealtimeMessage(message);
    };

    socket.onerror = () => {
      this.authError.set('Could not connect to the live room server.');
    };

    socket.onclose = () => {
      if (this.realtimeSocket === socket) {
        this.realtimeSocket = undefined;
      }

      if (!this.isRealtimeDisconnectExpected && this.signedIn() && this.currentRoomId()) {
        this.scheduleRealtimeReconnect();
      }
    };
  }

  private disconnectRealtime(): void {
    this.isRealtimeDisconnectExpected = true;
    this.clearRealtimeReconnect();
    this.closeRealtimeSocket();
  }

  private closeRealtimeSocket(): void {
    this.clearRealtimeReconnect();

    if (!this.realtimeSocket) {
      return;
    }

    this.realtimeSocket.onopen = null;
    this.realtimeSocket.onmessage = null;
    this.realtimeSocket.onerror = null;
    this.realtimeSocket.onclose = null;
    this.realtimeSocket.close();
    this.realtimeSocket = undefined;
  }

  private scheduleRealtimeReconnect(): void {
    if (this.reconnectTimeoutId) {
      return;
    }

    this.reconnectTimeoutId = window.setTimeout(() => {
      this.reconnectTimeoutId = undefined;
      this.connectRealtime();
    }, 2000);
  }

  private clearRealtimeReconnect(): void {
    if (!this.reconnectTimeoutId) {
      return;
    }

    window.clearTimeout(this.reconnectTimeoutId);
    this.reconnectTimeoutId = undefined;
  }

  private sendRealtime(event: string, data: unknown): void {
    if (this.realtimeSocket?.readyState !== WebSocket.OPEN) {
      return;
    }

    this.realtimeSocket.send(
      JSON.stringify({
        event,
        data,
      } satisfies RealtimeMessage),
    );
  }

  private handleRealtimeMessage(message: MessageEvent): void {
    let payload: RealtimeMessage;

    try {
      payload = JSON.parse(message.data) as RealtimeMessage;
    } catch {
      return;
    }

    switch (payload.event) {
      case 'chatMessage':
        this.handleChatMessage(payload.data as ChatMessageEvent);
        break;
      case 'roomUsers':
        this.handleRoomUsers(payload.data as RoomUsersEvent);
        break;
      case 'roomError':
        this.authError.set(
          (payload.data as SocketErrorResponse).message ||
            'The room socket reported an error.',
        );
        break;
      case 'videoState':
      case 'roomVideoState':
        this.applyRemoteVideoState(payload.data as VideoSyncEvent);
        break;
      case 'controlState':
        this.applyControlState(payload.data as ControlStateEvent);
        break;
    }
  }

  private handleChatMessage(message: ChatMessageEvent): void {
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
  }

  private handleRoomUsers(data: RoomUsersEvent): void {
    const users = data.users?.length ? data.users : [this.currentUserName()];
    this.participants.set(users);

    if (!this.controllerName() && users[0]) {
      this.controllerName.set(users[0]);
    }
  }

  private applyControlState(state: ControlStateEvent): void {
    if (state.controller) {
      this.controllerName.set(state.controller);
      this.rememberObservedPlayerTime();
    }
  }

  private emitVideoState(
    type: NonNullable<VideoSyncEvent['type']>,
    videoId = this.videoId(),
    currentTime = this.getPlayerCurrentTime(),
    isPlaying = this.isPlaying(),
  ): void {
    if (
      !this.realtimeSocket ||
      this.realtimeSocket.readyState !== WebSocket.OPEN ||
      !this.currentRoomId() ||
      !this.hasVideoControl() ||
      this.isApplyingRemoteVideoState
    ) {
      return;
    }

    this.sendRealtime('videoState', {
      roomId: this.currentRoomId(),
      sender: this.currentUserName(),
      senderClientId: this.senderClientId,
      type,
      videoId,
      currentTime,
      isPlaying,
      updatedAt: Date.now(),
    });
  }

  private applyRemoteVideoState(state: VideoSyncEvent): void {
    if (state.senderClientId === this.senderClientId) {
      return;
    }

    if (!this.isPlayerReady || !this.youtubePlayer) {
      this.pendingVideoState = state;
      if (state.videoId) {
        this.videoId.set(state.videoId);
      }
      return;
    }

    const nextVideoId = state.videoId || this.videoId();
    const nextTime = this.getSyncedTime(state);
    this.isApplyingRemoteVideoState = true;

    if (state.videoId && state.videoId !== this.videoId()) {
      this.videoId.set(state.videoId);
      if (state.type === 'change' || state.isPlaying) {
        this.pendingAutoplayVideoId = state.videoId;
      }
      this.youtubePlayer.loadVideoById({ videoId: state.videoId, startSeconds: 0 });
    }

    if (Number.isFinite(nextTime)) {
      this.youtubePlayer.seekTo(nextTime, true);
    }

    if (state.type === 'pause' || state.isPlaying === false) {
      this.youtubePlayer.pauseVideo();
      this.isPlaying.set(false);
    } else if (state.type === 'play' || state.type === 'change' || state.isPlaying) {
      this.youtubePlayer.playVideo();
      this.isPlaying.set(true);
      this.ensureVideoPlayback(nextVideoId);
    }

    this.videoId.set(nextVideoId);
    window.setTimeout(() => {
      this.isApplyingRemoteVideoState = false;
    }, 300);
  }

  private getSyncedTime(state: VideoSyncEvent): number {
    const currentTime = state.currentTime ?? 0;

    if (!state.isPlaying || !state.updatedAt) {
      return currentTime;
    }

    return currentTime + (Date.now() - state.updatedAt) / 1000;
  }

  private getPlayerCurrentTime(): number {
    return this.youtubePlayer?.getCurrentTime() ?? 0;
  }

  private startPlayerSyncMonitor(): void {
    if (this.playerSyncIntervalId) {
      return;
    }

    this.playerSyncIntervalId = window.setInterval(() => {
      if (
        !this.isPlayerReady ||
        !this.youtubePlayer ||
        !this.hasVideoControl() ||
        this.isApplyingRemoteVideoState
      ) {
        this.rememberObservedPlayerTime();
        return;
      }

      const now = Date.now();
      const currentTime = this.getPlayerCurrentTime();

      if (!this.lastObservedAt) {
        this.rememberObservedPlayerTime(currentTime, now);
        return;
      }

      const elapsedSeconds = (now - this.lastObservedAt) / 1000;
      const expectedTime = this.lastObservedPlayerTime + (this.isPlaying() ? elapsedSeconds : 0);
      const jumpedSeconds = Math.abs(currentTime - expectedTime);

      if (jumpedSeconds > 2.5) {
        this.emitVideoState('seek', this.videoId(), currentTime, this.isPlaying());
      }

      this.rememberObservedPlayerTime(currentTime, now);
    }, 1000);
  }

  private rememberObservedPlayerTime(
    currentTime = this.getPlayerCurrentTime(),
    observedAt = Date.now(),
  ): void {
    this.lastObservedPlayerTime = currentTime;
    this.lastObservedAt = observedAt;
  }

  private createSenderClientId(): string {
    const existingClientId = sessionStorage.getItem(SENDER_CLIENT_ID_KEY);

    if (existingClientId) {
      return existingClientId;
    }

    const clientId = crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
    sessionStorage.setItem(SENDER_CLIENT_ID_KEY, clientId);
    return clientId;
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

  private tryLoadVideoFromChat(text: string): boolean {
    const videoId = this.getYouTubeVideoId(text);

    if (!videoId) {
      return false;
    }

    if (!this.hasVideoControl()) {
      return false;
    }

    this.loadVideoById(videoId);
    return true;
  }

  private loadVideoFromLink(link: string, requireControl: boolean): boolean {
    if (requireControl && !this.hasVideoControl()) {
      return false;
    }

    const videoId = this.getYouTubeVideoId(link);

    if (!videoId) {
      return false;
    }

    this.loadVideoById(videoId);
    return true;
  }

  private loadVideoById(videoId: string): void {
    if (this.youtubePlayer) {
      this.pendingAutoplayVideoId = videoId;
      this.youtubePlayer.loadVideoById({ videoId, startSeconds: 0 });
    } else {
      this.videoId.set(videoId);
    }

    this.videoId.set(videoId);
    this.isPlaying.set(true);
    this.ensureVideoPlayback(videoId);
    this.emitVideoState('change', videoId, 0, true);
  }

  private ensureVideoPlayback(videoId: string): void {
    if (this.pendingAutoplayTimeoutId) {
      window.clearTimeout(this.pendingAutoplayTimeoutId);
    }

    this.pendingAutoplayVideoId = videoId;

    const retryPlayback = (attempt: number): void => {
      if (
        !this.youtubePlayer ||
        this.videoId() !== videoId ||
        this.pendingAutoplayVideoId !== videoId
      ) {
        return;
      }

      this.isPlaying.set(true);
      this.youtubePlayer.playVideo();

      if (attempt < 6) {
        this.pendingAutoplayTimeoutId = window.setTimeout(
          () => retryPlayback(attempt + 1),
          350,
        );
      }
    };

    retryPlayback(0);
  }

  private clearPendingAutoplay(): void {
    this.pendingAutoplayVideoId = '';

    if (this.pendingAutoplayTimeoutId) {
      window.clearTimeout(this.pendingAutoplayTimeoutId);
      this.pendingAutoplayTimeoutId = undefined;
    }
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
        onReady: () => {
          this.isPlayerReady = true;
          this.rememberObservedPlayerTime();
          this.startPlayerSyncMonitor();
          if (this.pendingVideoState) {
            const state = this.pendingVideoState;
            this.pendingVideoState = undefined;
            this.applyRemoteVideoState(state);
          }
        },
        onStateChange: (event) => {
          const state = window.YT?.PlayerState;

          if (!state) {
            return;
          }

          if (event.data === state.PLAYING) {
            this.clearPendingAutoplay();
            this.isPlaying.set(true);
            const currentTime = this.getPlayerCurrentTime();
            this.rememberObservedPlayerTime(currentTime);
            this.emitVideoState('play', this.videoId(), currentTime, true);
          }

          if (event.data === state.PAUSED || event.data === state.ENDED) {
            if (this.pendingAutoplayVideoId === this.videoId()) {
              this.ensureVideoPlayback(this.videoId());
              return;
            }

            this.isPlaying.set(false);
            const currentTime = this.getPlayerCurrentTime();
            this.rememberObservedPlayerTime(currentTime);
            this.emitVideoState('pause', this.videoId(), currentTime, false);
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
