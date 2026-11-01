import { initializeApp } from "firebase/app";
import { getDatabase } from "firebase/database";
import { getAuth } from "firebase/auth"; // <-- New import

const firebaseConfig = {
  apiKey: "AIzaSyAjD-uI1yP8J4_EKnXUI1o6GNzdYfbLp7M",
  authDomain: "boston-board.firebaseapp.com",
  databaseURL: "https://boston-board-default-rtdb.firebaseio.com",
  projectId: "boston-board",
  storageBucket: "boston-board.firebasestorage.app",
  messagingSenderId: "190274207885",
  appId: "1:190274207885:web:3f69f108fed98fccc962c4"
};

export const app = initializeApp(firebaseConfig);
export const db = getDatabase(app);
export const auth = getAuth(app); // <-- Initialize auth