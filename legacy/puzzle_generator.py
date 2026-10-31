import numpy as np
import itertools as it
import time

p = []

#last
p+=[[(0,3,4),(0,4,4),(0,3,5),(0,4,5),
     (1,3,4),(1,4,4),(1,3,5),(1,4,5),
     (2,3,5),(2,4,5),
     (3,4,5),
     (4,4,5),
     (5,3,5),(5,4,5),
     (6,3,4),(6,4,4),(6,3,5),(6,4,5),
     (7,3,4),(7,4,4),(7,3,5),(7,4,5)]]
#deux taquets
p+=[[(2,0,3),(2,0,4),(3,0,3),(3,0,4),
     (2,1,3),(2,1,4),(3,1,3),(3,1,4),
     (2,2,3),(2,2,4),
     (2,3,3),(2,3,4),(3,3,3),
     (2,4,4),(3,4,4),
     (2,5,3),(2,5,4),
     (2,6,3),(2,6,4),(3,6,3),(3,6,4),
     (2,7,3),(2,7,4),(3,7,3),(3,7,4)]]
#un taquet
p+=[[(0,3,2),(0,4,2),(0,3,3),(0,4,3),
     (1,3,2),(1,4,2),(1,3,3),(1,4,3),
     (2,3,2),(2,4,2),(2,4,3),
     (3,4,2),
     (4,4,2),(4,4,3),
     (5,3,2),(5,4,2),
     (6,3,2),(6,4,2),(6,3,3),(6,4,3),
     (7,3,2),(7,4,2),(7,3,3),(7,4,3)]]
#encoche droite
p+=[[(3,4,0),(4,4,0),(3,5,0),(4,5,0),
     (3,4,1),(4,4,1),(3,5,1),(4,5,1),
     (3,5,2),(4,5,2),
     (3,5,3),(4,5,3),
     (3,5,4),
     (3,5,5),(4,5,5),
     (3,4,6),(4,4,6),(3,5,6),(4,5,6),
     (3,4,7),(4,4,7),(3,5,7),(4,5,7)]]
#first
p+=[[(4,0,3),(5,0,3),(4,0,4),(5,0,4),
     (4,1,3),(5,1,3),(4,1,4),(5,1,4),
     (5,2,3),(4,2,4),(5,2,4),
     (4,3,4),
     (4,4,4),
     (5,5,3),(4,5,4),(5,5,4),
     (4,6,3),(5,6,3),(4,6,4),(5,6,4),
     (4,7,3),(5,7,3),(4,7,4),(5,7,4)]]
#bizarre
p+=[[(3,2,0),(4,2,0),(3,3,0),(4,3,0),
     (3,2,1),(4,2,1),(3,3,1),(4,3,1),
     (3,2,2),(4,2,2),(3,3,2),(4,3,2),
     (3,2,3),(4,3,3),
     (3,2,4),
     (3,2,5),(4,2,5),(4,3,5),
     (3,2,6),(4,2,6),(3,3,6),(4,3,6),
     (3,2,7),(4,2,7),(3,3,7),(4,3,7)]]

side = 8
margin = 7
pieces = [np.zeros((side+margin,side+margin,side+margin)) for i in range(6)]

for piece in p:
   for x,y,z in piece:
      pieces[0][x+margin][y+margin][z+margin] = 1

POSSIBLE_MOVES = np.array([[1,0,0],
                           [-1,0,0],
                           [0,1,0],
                           [0,-1,0],
                           [0,0,1],
                           [0,0,-1]])

# Functions
def move_piece(pieces, move):
   return [np.roll(p, sum(move), axis=sum(j if t else 0 for j,t in enumerate(move))) for p in pieces]

def get_possible_moves(moves, solutions, assemblies, pieces_list):
   ps_ids = [(i,p) for i,p in enumerate(pieces_list)]
   opts = sum([list(it.combinations(range(len(pieces_list)), i+1)) for i in range(int(len(pieces_list)/2))], [])
   for ids in opts:
      left_pieces = [i for i in range(len(pieces_list)) if i not in ids]
      #print(left_pieces)
      for m in POSSIBLE_MOVES:
         moves = moves + [(ids,m)]
         moved = move_piece([pieces_list[i] for i in ids], m)
         #assembly = moved + sum(pieces_list[left_pieces])
         #TODO : prendre en compte toutes les pieces pour le move
         assembly = sum(moved) + sum(pieces_list[i] for i in left_pieces)
         if any([np.array_equal(assembly,ass) for ass in assemblies]):
            print("Already known position.")
            continue
         if 2 not in np.ravel(assembly):
            print("Possible move !")
            print(ids, m)
            print(moves)
            time.sleep(0.5)
            if len(moves) > 10: #this_is_a_solution:
               solutions.append(moves.copy())
            else:
               new_pieces_list = pieces_list.copy()
               for i,p_moved in zip(ids,moved):
                   new_pieces_list[i] = p_moved
               get_possible_moves(moves.copy(), solutions, assemblies+[assembly], new_pieces_list )


def solve(pieces_list):
   
   positions = [np.zeros(3) for i in range(len(pieces_list))]
   
   print("Solving...")
   print(pieces_list)
   
   solutions = []
   get_possible_moves([], solutions, [], pieces_list)
   n_moves = max(len(s) for s in solutions)
   
   if n_moves:
      for i,s in enumerate(solutions):
         print("Solution n°",i+1)
         print(s)
      print("There is a solution ! It's a {} moves"
        .format(n_moves))
   else:
      print("There is no solution. Sorry...")
   return n_moves


# Main program
if __name__=="__main__":
   solve(pieces)
   