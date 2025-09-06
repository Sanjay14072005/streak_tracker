// Keep access token in memory (safer vs localStorage); refresh token in localStorage.
export const auth = {
  accessToken: null,

  getRefreshToken() {
    return localStorage.getItem("refreshToken");
  },

  setTokens({ accessToken, refreshToken }) {
    if (accessToken) auth.accessToken = accessToken;
    if (refreshToken) localStorage.setItem("refreshToken", refreshToken);
  },

  clear() {
    auth.accessToken = null;
    localStorage.removeItem("refreshToken");
  },

  isAuthenticated() {
    return !!auth.accessToken || !!auth.getRefreshToken();
  },
};
