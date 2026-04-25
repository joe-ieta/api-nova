import axios from "axios";
import type { AxiosResponse } from "axios";

// Paginated document response.
export interface PaginatedResponse<T> {
  documents: T[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

// Document API types.
export interface Document {
  id: string;
  name: string;
  description?: string;
  content: string;
  status: "draft" | "published" | "archived" | "valid" | "invalid" | "pending";
  version: string;
  tags?: string[];
  metadata?: {
    originalUrl?: string;
    importSource?: "file" | "url" | "manual";
    fileSize?: number;
    lastValidated?: Date;
    validationErrors?: string[];
    [key: string]: any;
  };
  userId: string;
  createdAt: string;
  updatedAt: string;
  info?: {
    title?: string;
    version?: string;
    description?: string;
  };
  endpointCount?: number;
}

export interface CreateDocumentDto {
  name: string;
  description?: string;
  content: string;
  status?: "draft" | "published" | "archived" | "valid" | "invalid" | "pending";
  version?: string;
  tags?: string[];
  metadata?: {
    originalUrl?: string;
    importSource?: "file" | "url" | "manual";
    fileSize?: number;
    lastValidated?: Date;
    validationErrors?: string[];
    [key: string]: any;
  };
}

export interface UpdateDocumentDto {
  name?: string;
  description?: string;
  content?: string;
  status?: "draft" | "published" | "archived" | "valid" | "invalid" | "pending";
  version?: string;
  tags?: string[];
  metadata?: {
    originalUrl?: string;
    importSource?: "file" | "url" | "manual";
    fileSize?: number;
    lastValidated?: Date;
    validationErrors?: string[];
    [key: string]: any;
  };
}


// API base configuration.
const API_BASE_URL = "/api";

// Axios instance for document APIs.
const apiClient = axios.create({
  baseURL: API_BASE_URL,
  timeout: 30000,
  headers: {
    "Content-Type": "application/json",
  },
});

// Attach JWT token when present.
apiClient.interceptors.request.use(
  (config) => {
    const token =
      localStorage.getItem("auth_token") ||
      sessionStorage.getItem("auth_token");
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
  },
  (error) => {
    return Promise.reject(error);
  },
);

// Handle common document API errors.
apiClient.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401) {
      console.warn("Document request unauthorized");
    }
    return Promise.reject(error);
  },
);

// Document management API.
export const documentsApi = {
  // Fetch the current user's documents.
  async getDocuments(): Promise<Document[]> {
    try {
      const response: AxiosResponse<PaginatedResponse<Document>> =
        await apiClient.get("/documents");
      // Extract documents from the paginated response.
      return response.data.documents || [];
    } catch (error) {
      console.error("Failed to fetch documents:", error);
      throw error;
    }
  },

  // Fetch a single document.
  async getDocument(id: string): Promise<Document> {
    try {
      const response: AxiosResponse<Document> = await apiClient.get(
        `/documents/${id}`,
      );
      return response.data;
    } catch (error) {
      console.error(`Failed to fetch document ${id}:`, error);
      throw error;
    }
  },

  // Create a document.
  async createDocument(data: CreateDocumentDto): Promise<Document> {
    try {
      const response: AxiosResponse<Document> = await apiClient.post(
        "/documents",
        data,
      );
      return response.data;
    } catch (error) {
      console.error("Failed to create document:", error);
      throw error;
    }
  },

  // Update a document.
  async updateDocument(id: string, data: UpdateDocumentDto): Promise<Document> {
    try {
      const response: AxiosResponse<Document> = await apiClient.patch(
        `/documents/${id}`,
        data,
      );
      return response.data;
    } catch (error) {
      console.error(`Failed to update document ${id}:`, error);
      throw error;
    }
  },

  // Delete a document.
  async deleteDocument(id: string): Promise<void> {
    try {
      await apiClient.delete(`/documents/${id}`);
    } catch (error) {
      console.error(`Failed to delete document ${id}:`, error);
      throw error;
    }
  },

  // Check whether the stored auth token can access document APIs.
  async checkAuth(): Promise<boolean> {
    try {
      const token =
        localStorage.getItem("auth_token") ||
        sessionStorage.getItem("auth_token");
      if (!token) {
        console.log("No auth token found");
        return false;
      }

      // Validate the token by calling an authenticated endpoint.
      const response = await apiClient.get("/documents");
      console.log(
        "Auth check successful, documents loaded:",
        response.data?.length || 0,
      );
      return true;
    } catch (error: any) {
      console.error(
        "Auth check failed:",
        error.response?.status,
        error.message,
      );
      return false;
    }
  },

};

export default documentsApi;
