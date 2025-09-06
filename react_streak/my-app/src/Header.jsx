import React, { useState, useRef, useEffect } from "react";
import "./styles.css";

/**
 * Header
 * @param {number}  streak  Overall streak count
 * @param {boolean} active  Glow only when ALL lists are done today
 * @param {() => void} onLogout
 */
export default function Header({ streak = 0, active = false, onLogout }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef(null);

  // Close menu on outside click or Esc
  useEffect(() => {
    function handleDocClick(e) {
      if (menuRef.current && !menuRef.current.contains(e.target)) {
        setMenuOpen(false);
      }
    }
    function handleEsc(e) {
      if (e.key === "Escape") setMenuOpen(false);
    }
    document.addEventListener("mousedown", handleDocClick);
    document.addEventListener("keydown", handleEsc);
    return () => {
      document.removeEventListener("mousedown", handleDocClick);
      document.removeEventListener("keydown", handleEsc);
    };
  }, []);

  return (
    <header className="app-header">
      <h1 className="app-title">Streaky To-Dos</h1>

      <div className="header-right">
        {/* Overall streak chip */}
        <div
          className={`streak-chip ${active ? "active" : ""}`}
          title={`Overall streak: ${streak}${
            active ? " — completed today ✅" : ""
          }`}
          aria-live="polite"
          aria-label={`Overall streak ${streak} ${
            active ? "(completed today)" : ""
          }`}
        >
          {/* Same flame shape as list cards */}
          <svg
            viewBox="0 0 24 24"
            className="flame"
            width="18"
            height="18"
            aria-hidden="true"
          >
            <path d="M12 2c0 4-3 4.5-3 8 0 1.8 1.2 3 3 3s3-1.2 3-3c0-1.7-.6-3.1-1.2-4.3-.4-.9 0-2 1-2.2C18 4.2 20 7.4 20 11.1 20 15.5 16.9 19 12 19S4 15.5 4 11.1c0-2.4 1.1-4.7 2.9-6.2.7-.6 1.9 0 1.7.9C8.2 6.7 8 7.6 8 8c0 1.7 1.3 3 3 3" />
          </svg>
          <span className="count">{streak}</span>
        </div>

        {/* Profile dropdown */}
        <div className="profile-dropdown" ref={menuRef}>
          <img
            src="/avatar.png"
            alt="Profile"
            className="avatar"
            onClick={() => setMenuOpen((v) => !v)}
          />
          {menuOpen && (
            <div className="dropdown-menu">
              <button onClick={onLogout}>Log out</button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
