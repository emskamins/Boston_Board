import React, { useState, useEffect } from 'react';

// Utility to format Date to YYYY-MM-DD
const formatDate = (date) => date.toISOString().split('T')[0];

// Format time to 12-hour AM/PM
const formatTime12 = (dateObj) => {
  return dateObj.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
};

const App = () => {
  const [currentTime, setCurrentTime] = useState(new Date());
  const [zmanim, setZmanim] = useState(null);
  const [tickerMessages, setTickerMessages] = useState(["טוען הודעות..."]); // Live state for ticker

  // Real-time Firebase Ticker Listener
  useEffect(() => {
    const tickerRef = ref(db, 'ticker');
    
    const unsubscribe = onValue(tickerRef, (snapshot) => {
      const data = snapshot.val();
      if (data) {
        if (typeof data === 'string') {
          setTickerMessages([data]);
        } else {
          setTickerMessages(Object.values(data));
        }
      } else {
        setTickerMessages(["אין הודעות חדשות"]);
      }
    });

    return () => unsubscribe();
  }, []);

  // Update real-time clock every minute
  useEffect(() => {
    const timer = setInterval(() => setCurrentTime(new Date()), 60000);
    return () => clearInterval(timer);
  }, []);

  // Fetch and Cache Hebcal Data
  useEffect(() => {
    const fetchHebcalData = async () => {
      const today = new Date();
      const todayString = formatDate(today);
      
      const nextMonth = new Date();
      nextMonth.setDate(today.getDate() + 30);
      const nextMonthString = formatDate(nextMonth);
    
      const zipCode = "10001"; // Update with your Shul's Zip
      const apiUrl = `https://www.hebcal.com/zmanim?cfg=json&zip=${zipCode}&start=${todayString}&end=${nextMonthString}`;
    
      try {
        const response = await fetch(apiUrl);
        if (!response.ok) throw new Error("Network offline");
        const data = await response.json();
        
        localStorage.setItem('shulZmanimCache', JSON.stringify({
          timestamp: Date.now(),
          data: data
        }));
        extractToday(data, todayString);
      } catch (error) {
        console.warn("Internet offline. Falling back to local cache.", error);
        const cached = localStorage.getItem('shulZmanimCache');
        if (cached) {
          const parsedCache = JSON.parse(cached);
          extractToday(parsedCache.data, todayString);
        }
      }
    };

    const extractToday = (fullData, todayString) => {
      if (fullData.times && fullData.times[todayString]) {
        // Format API strings to 12-hour AM/PM
        const times = fullData.times[todayString];
        const formattedZmanim = {
          alos: formatTime12(new Date(times.alotHaShachar)),
          netz: formatTime12(new Date(times.neitzHachama)),
          chatzos: formatTime12(new Date(times.chatzot)),
          shkia: formatTime12(new Date(times.shkiah)),
          tzeis: formatTime12(new Date(times.tzeit7083deg)) // 42 min
        };
        setZmanim(formattedZmanim);
      }
    };

    fetchHebcalData();
    // Refresh Zmanim automatically every night at 2 AM
    const msUntil2AM = new Date().setHours(26, 0, 0, 0) - Date.now();
    const nightlyRefresh = setTimeout(fetchHebcalData, msUntil2AM);
    return () => clearTimeout(nightlyRefresh);
  }, []);

  // Mocked schedule (Phase 1)
  const minyanim = [
    { label: "שחרית (א)", time: "6:15 AM" },
    { label: "שחרית (ב)", time: "7:00 AM" },
    { label: "שחרית (ג)", time: "8:00 AM" },
    { label: "מנחה", time: "4:30 PM" },
    { label: "מעריב (א)", time: "5:15 PM" },
    { label: "מעריב (ב)", time: "8:30 PM" }
  ];

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Heebo:wght@400;700;900&display=swap');
        
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { 
          background-color: #000; 
          color: #fff; 
          font-family: 'Heebo', sans-serif; 
          overflow: hidden; 
        }
        .board-container {
          width: 100vw;
          height: 100vh;
          display: flex;
          flex-direction: column;
          direction: rtl;
        }
        .header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 2vh 4vw;
          background-color: #111;
          border-bottom: 4px solid #333;
          height: 15vh;
        }
        .shul-brand h1 { font-size: 4vh; font-weight: 900; }
        .shul-brand p { font-size: 2vh; color: #aaa; }
        .clock-section { text-align: left; }
        .clock-section h2 { font-size: 6vh; font-weight: 900; direction: ltr; }
        .clock-section p { font-size: 2.5vh; color: #aaa; }
        
        .main-grid {
          display: grid;
          grid-template-columns: 1fr 2fr 1fr;
          gap: 2vw;
          padding: 3vh 4vw;
          height: 75vh;
        }
        .panel {
          background-color: #111;
          border-radius: 16px;
          padding: 3vh 2vw;
          border: 1px solid #222;
        }
        .panel h3 {
          font-size: 3.5vh;
          margin-bottom: 2vh;
          color: #f1c40f;
          text-align: center;
          border-bottom: 2px solid #333;
          padding-bottom: 1vh;
        }
        
        /* Zmanim */
        .zman-row {
          display: flex;
          justify-content: space-between;
          font-size: 2.5vh;
          margin-bottom: 1.5vh;
        }
        .zman-row .time { direction: ltr; font-weight: 700; color: #ddd; }
        
        /* Minyanim (Center Focus) */
        .minyan-row {
          display: flex;
          justify-content: space-between;
          align-items: center;
          font-size: 4vh;
          margin-bottom: 2vh;
          background-color: #1a1a1a;
          padding: 1.5vh 2vw;
          border-radius: 12px;
        }
        .minyan-row .time {
          direction: ltr;
          font-weight: 900;
          color: #fff;
        }

        /* Ticker */
        .ticker-wrap {
          height: 10vh;
          background-color: #0d47a1;
          display: flex;
          align-items: center;
          overflow: hidden;
          white-space: nowrap;
          position: relative;
        }
        .ticker {
          display: inline-block;
          white-space: nowrap;
          animation: ticker-scroll 25s linear infinite;
          font-size: 4vh;
          font-weight: 700;
        }
        .ticker-item { margin: 0 4vw; }
        @keyframes ticker-scroll {
          0% { transform: translate3d(100vw, 0, 0); }
          100% { transform: translate3d(-100%, 0, 0); }
        }
      `}</style>

      <div className="board-container">
        {/* HEADER */}
        <header className="header">
          <div className="shul-brand">
            <h1>בית כנסת אוהל משה</h1>
            <p>קהילת קודש</p>
          </div>
          <div className="clock-section">
            <h2>{formatTime12(currentTime)}</h2>
            <p>פרשת השבוע: ויקרא</p>
          </div>
        </header>

        {/* MAIN CONTENT GRID */}
        <main className="main-grid">
          
          {/* Right Column: Zmanim */}
          <div className="panel">
            <h3>זמנים</h3>
            {zmanim ? (
              <>
                <div className="zman-row"><span>עלות השחר</span><span className="time">{zmanim.alos}</span></div>
                <div className="zman-row"><span>נץ החמה</span><span className="time">{zmanim.netz}</span></div>
                <div className="zman-row"><span>חצות</span><span className="time">{zmanim.chatzos}</span></div>
                <div className="zman-row"><span>שקיעה</span><span className="time">{zmanim.shkia}</span></div>
                <div className="zman-row"><span>צאת הכוכבים</span><span className="time">{zmanim.tzeis}</span></div>
              </>
            ) : (
              <div style={{textAlign: 'center', marginTop: '5vh'}}>טוען זמנים...</div>
            )}
          </div>

          {/* Center Column: Minyanim */}
          <div className="panel" style={{ backgroundColor: '#0a0a0a' }}>
            <h3 style={{ fontSize: '4.5vh' }}>זמני תפילה</h3>
            {minyanim.map((minyan, idx) => (
              <div key={idx} className="minyan-row">
                <span>{minyan.label}</span>
                <span className="time">{minyan.time}</span>
              </div>
            ))}
          </div>

          {/* Left Column: Info/Shiurim */}
          <div className="panel">
            <h3>הודעות הקהילה</h3>
            <div style={{ fontSize: '2.5vh', lineHeight: '1.8' }}>
              <p><strong>קידוש השבת</strong> נתרם על ידי משפחת לוי לעילוי נשמת אביהם.</p>
              <hr style={{ borderColor: '#333', margin: '2vh 0' }} />
              <p><strong>שיעור הלכה</strong> מידי יום בין מנחה לערבית עם הרב.</p>
              <hr style={{ borderColor: '#333', margin: '2vh 0' }} />
              <p><strong>אבות ובנים</strong> מוצאי שבת בשעה 7:00. פיצה ופרסים לילדים!</p>
            </div>
          </div>
        </main>

        {/* FOOTER TICKER */}
        <footer className="ticker-wrap">
          <div className="ticker">
            {tickerMessages.map((msg, idx) => (
              <span key={idx} className="ticker-item">• {msg} </span>
            ))}
          </div>
        </footer>
      </div>
    </>
  );
};

export default App;