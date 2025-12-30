export interface Episode { season?: string; name: string; url: string; }

export interface Movie {
  id: string; title: string; posterUrl: string; coverUrl: string;
  category: "Movies" | "Series" | "Adult" | "All Uncensored"; 
  description: string; tags: string; year: string; 
  streamUrl: string; streamUrl2?: string;
  episodes?: Episode[];
  linkType: "direct" | "embed"; 
  downloadUrl?: string; downloadUrl2?: string;
  createdAt: number;
}

export interface User {
  username: string; passwordHash: string; expiryDate: string | null; 
  favorites: string[]; sessionId?: string;
}

export interface VipKey { code: string; days: number; }
export interface UserRequest { id: string; username: string; movieName: string; timestamp: number; }
export interface AppConfig { announcement: string; showAnnouncement: boolean; }
