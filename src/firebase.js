import { initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";
import { getAuth, GoogleAuthProvider } from "firebase/auth";

const firebaseConfig = {
  apiKey: "AIzaSyCm5XSSyebL3_hmnFFlLLBKcOyOFy9Iw9o",
  authDomain: "myown-332af.firebaseapp.com",
  projectId: "myown-332af",
  storageBucket: "myown-332af.firebasestorage.app",
  messagingSenderId: "817318822187",
  appId: "1:817318822187:web:be12c0394cb3ba5dcd056e",
  measurementId: "G-GSB20XB2Q4"
};

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
export const auth = getAuth(app);
export const googleProvider = new GoogleAuthProvider();
