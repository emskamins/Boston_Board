import React, { useState, useEffect } from 'react';
import { ref, onValue, push, remove } from 'firebase/database';
import { signInWithEmailAndPassword, signOut, onAuthStateChanged } from 'firebase/auth';
import { db, auth } from './firebase';

const Admin = () => {
  // Firebase Auth State
  const [user, setUser] = useState(null);
  const [loadingAuth, setLoadingAuth] = useState(true);
  
  // Login Form State
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loginError, setLoginError] = useState("");

  // Database State
  const [messages, setMessages] = useState([]);
  const [newMessage, setNewMessage] = useState("");

  // Listen for login status changes
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
      setUser(currentUser);
      setLoadingAuth(false);
    });
    return () => unsubscribe();
  }, []);

  // Fetch data only if logged in
  useEffect(() => {
    if (!user) return;

    const tickerRef = ref(db, 'ticker');
    const unsubscribe = onValue(tickerRef, (snapshot) => {
      const data = snapshot.val();
      if (data) {
        if (typeof data === 'string') {
          setMessages([{ id: 'legacy', text: data }]);
        } else {
          const msgArray = Object.keys(data).map(key => ({ id: key, text: data[key] }));
          setMessages(msgArray);
        }
      } else {
        setMessages([]);
      }
    });
    return () => unsubscribe();
  }, [user]);

  const handleLogin = async (e) => {
    e.preventDefault();
    setLoginError("");
    try {
      await signInWithEmailAndPassword(auth, email, password);
    } catch (err) {
      setLoginError("Invalid email or password.");
    }
  };

  const handleLogout = async () => {
    await signOut(auth);
  };

  const handleAdd = (e) => {
    e.preventDefault();
    if (newMessage.trim() === "") return;
    push(ref(db, 'ticker'), newMessage.trim()).catch(err => alert("Permission denied"));
    setNewMessage("");
  };

  const handleDelete = (id) => {
    const targetRef = id === 'legacy' ? ref(db, 'ticker') : ref(db, `ticker/${id}`);
    remove(targetRef).catch(err => alert("Permission denied"));
  };

  if (loadingAuth) return <div style={{textAlign: 'center', marginTop: '50px'}}>Loading...</div>;

  // --- SECURE LOGIN SCREEN ---
  if (!user) {
    return (
      <div style={{ padding: '50px 20px', fontFamily: 'sans-serif', maxWidth: '400px', margin: '0 auto', textAlign: 'center' }}>
        <h2>Secure Admin Login</h2>
        <form onSubmit={handleLogin} style={{ display: 'flex', flexDirection: 'column', gap: '15px', marginTop: '20px' }}>
          <input 
            type="email" 
            value={email} 
            onChange={(e) => setEmail(e.target.value)} 
            placeholder="Email address" 
            style={{ padding: '12px', fontSize: '16px', border: '1px solid #ccc', borderRadius: '4px' }}
            required
          />
          <input 
            type="password" 
            value={password} 
            onChange={(e) => setPassword(e.target.value)} 
            placeholder="Password" 
            style={{ padding: '12px', fontSize: '16px', border: '1px solid #ccc', borderRadius: '4px' }}
            required
          />
          {loginError && <p style={{ color: '#d32f2f', margin: 0 }}>{loginError}</p>}
          <button type="submit" style={{ padding: '12px', fontSize: '16px', background: '#0d47a1', color: '#fff', border: 'none', borderRadius: '4px', cursor: 'pointer' }}>
            Login
          </button>
        </form>
      </div>
    );
  }

  // --- SECURE DASHBOARD SCREEN ---
  return (
    <div style={{ padding: '20px', fontFamily: 'sans-serif', maxWidth: '600px', margin: '0 auto', direction: 'ltr', color: '#333' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '2px solid #eee', paddingBottom: '10px' }}>
        <div>
          <h2 style={{ margin: 0 }}>Admin Dashboard</h2>
          <p style={{ margin: '5px 0 0 0', fontSize: '12px', color: '#666' }}>Logged in as: {user.email}</p>
        </div>
        <button onClick={handleLogout} style={{ background: '#eee', border: 'none', padding: '5px 10px', borderRadius: '4px', cursor: 'pointer' }}>
          Logout
        </button>
      </div>
      
      <form onSubmit={handleAdd} style={{ display: 'flex', gap: '10px', marginBottom: '30px', marginTop: '20px' }}>
        <input 
          type="text" 
          value={newMessage} 
          onChange={(e) => setNewMessage(e.target.value)} 
          placeholder="Type a new message..." 
          dir="auto"
          style={{ flex: 1, padding: '10px', fontSize: '16px', border: '1px solid #ccc', borderRadius: '4px' }}
        />
        <button type="submit" style={{ padding: '10px 20px', fontSize: '16px', background: '#0d47a1', color: '#fff', border: 'none', borderRadius: '4px', cursor: 'pointer' }}>
          Add
        </button>
      </form>

      <ul style={{ listStyle: 'none', padding: 0 }}>
        {messages.length === 0 && (
          <li style={{ textAlign: 'center', color: '#777', marginTop: '20px' }}>No messages currently active.</li>
        )}
        {messages.map((msg) => (
          <li key={msg.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '15px', background: '#f5f5f5', marginBottom: '10px', borderRadius: '4px', border: '1px solid #ddd' }}>
            <span style={{ fontSize: '18px' }} dir="auto">{msg.text}</span>
            <button onClick={() => handleDelete(msg.id)} style={{ background: '#d32f2f', color: '#fff', border: 'none', padding: '8px 15px', borderRadius: '4px', cursor: 'pointer', marginLeft: '15px' }}>
              Delete
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
};

export default Admin;